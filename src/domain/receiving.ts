import type { Tx } from '../db/index.js'
import { num, numOrNull } from '../db/index.js'
import { DomainError } from './errors.js'
import { audit, priceFor } from './items.js'
import { getSettings } from './settings.js'
import { postMovements } from './stock.js'
import { packsToUnits } from './units.js'

export interface InvoiceLineInput {
  itemId: string
  qtyPacks: number
  bonusPacks?: number
  costPerPack: number        // excl VAT
  updateRetail?: boolean
}

export async function createSupplier(tx: Tx, input: { name: string; code?: string; phone?: string; email?: string }) {
  if (!input.name.trim()) throw new DomainError('supplier name is required')
  const [row] = await tx`
    insert into suppliers (tenant_id, name, code, phone, email)
    values (current_setting('app.tenant_id')::uuid, ${input.name.trim()}, ${input.code ?? null}, ${input.phone ?? null}, ${input.email ?? null})
    on conflict (tenant_id, name) do update set name = excluded.name
    returning id`
  return row.id as string
}

export async function createInvoice(tx: Tx, input: { supplierId: string; invoiceNo: string; invoiceDate: string; note?: string }, userId?: string) {
  if (!input.invoiceNo.trim()) throw new DomainError('invoice number is required')
  const [dupe] = await tx`select id from supplier_invoices where supplier_id = ${input.supplierId} and invoice_no = ${input.invoiceNo.trim()}`
  if (dupe) throw new DomainError(`invoice ${input.invoiceNo} from this supplier is already captured`, 'duplicate', 409)
  const [row] = await tx`
    insert into supplier_invoices (tenant_id, supplier_id, invoice_no, invoice_date, note, created_by)
    values (current_setting('app.tenant_id')::uuid, ${input.supplierId}, ${input.invoiceNo.trim()}, ${input.invoiceDate}, ${input.note ?? null}, ${userId ?? null})
    returning id`
  return row.id as string
}

async function draft(tx: Tx, invoiceId: string) {
  const [inv] = await tx`select * from supplier_invoices where id = ${invoiceId} for update`
  if (!inv) throw new DomainError('unknown invoice', 'not_found', 404)
  if (inv.status !== 'draft') throw new DomainError('invoice is already posted', 'posted', 409)
  return inv
}

export async function addInvoiceLine(tx: Tx, invoiceId: string, line: InvoiceLineInput) {
  await draft(tx, invoiceId)
  if (!(line.qtyPacks >= 0) || !((line.bonusPacks ?? 0) >= 0) || line.qtyPacks + (line.bonusPacks ?? 0) <= 0) {
    throw new DomainError('quantity must be more than zero')
  }
  const settings = await getSettings(tx)
  if (!(line.costPerPack >= 0) || line.costPerPack > settings.maxSaneCost) throw new DomainError(`cost P${line.costPerPack} is outside the allowed range`)
  const [{ n }] = await tx`select coalesce(max(line_no), 0) + 1 as n from supplier_invoice_lines where invoice_id = ${invoiceId}`
  const [row] = await tx`
    insert into supplier_invoice_lines (tenant_id, invoice_id, item_id, qty_packs, bonus_packs, cost_per_pack, update_retail, line_no)
    values (current_setting('app.tenant_id')::uuid, ${invoiceId}, ${line.itemId}, ${line.qtyPacks}, ${line.bonusPacks ?? 0},
            ${line.costPerPack}, ${line.updateRetail ?? true}, ${n})
    returning id`
  return row.id as string
}

export async function removeInvoiceLine(tx: Tx, invoiceId: string, lineId: string) {
  await draft(tx, invoiceId)
  await tx`delete from supplier_invoice_lines where id = ${lineId} and invoice_id = ${invoiceId}`
}

export async function getInvoice(tx: Tx, invoiceId: string) {
  const [inv] = await tx`select si.*, s.name as supplier_name from supplier_invoices si join suppliers s on s.id = si.supplier_id where si.id = ${invoiceId}`
  if (!inv) return null
  const settings = await getSettings(tx)
  const lines = await tx`
    select l.*, i.stock_code, i.description, i.pack_size, i.cost_per_pack as current_cost, i.retail_per_pack as current_retail,
           i.markup_override, i.vat_rate
      from supplier_invoice_lines l join items i on i.id = l.item_id
     where l.invoice_id = ${invoiceId} order by l.line_no`
  let totalExcl = 0
  let vat = 0
  const out = lines.map((l) => {
    const lineExcl = num(l.qty_packs) * num(l.cost_per_pack)
    const rate = numOrNull(l.vat_rate) ?? settings.vatRate
    totalExcl += lineExcl
    vat += lineExcl * rate
    return {
      id: l.id as string, lineNo: l.line_no as number, itemId: l.item_id as string, stockCode: l.stock_code as string,
      description: l.description as string, packSize: l.pack_size as number, qtyPacks: num(l.qty_packs), bonusPacks: num(l.bonus_packs),
      costPerPack: num(l.cost_per_pack), currentCost: numOrNull(l.current_cost), currentRetail: num(l.current_retail),
      newRetail: l.update_retail ? priceFor(settings, num(l.cost_per_pack), numOrNull(l.markup_override), numOrNull(l.vat_rate)) : num(l.current_retail),
      updateRetail: l.update_retail as boolean, lineExcl,
    }
  })
  return {
    id: inv.id as string, supplierId: inv.supplier_id as string, supplierName: inv.supplier_name as string,
    invoiceNo: inv.invoice_no as string, invoiceDate: inv.invoice_date as Date, status: inv.status as string, note: inv.note as string | null,
    lines: out, totalExcl, vat, totalIncl: totalExcl + vat,
  }
}

/**
 * Post a supplier invoice: stock goes up, last cost and weighted average cost update,
 * and retail is re-priced by the markup rule on lines that ask for it.
 */
export async function postInvoice(tx: Tx, invoiceId: string, userId?: string) {
  const inv = await draft(tx, invoiceId)
  const settings = await getSettings(tx)
  const lines = await tx`
    select l.*, i.pack_size, i.cost_per_pack as old_cost, i.avg_cost_per_pack as old_avg, i.retail_per_pack as old_retail,
           i.markup_override, i.vat_rate, i.status, coalesce(s.on_hand_units, 0) as on_hand
      from supplier_invoice_lines l join items i on i.id = l.item_id left join stock_levels s on s.item_id = i.id
     where l.invoice_id = ${invoiceId} order by l.line_no`
  if (!lines.length) throw new DomainError('invoice has no lines')
  const occurredAt = new Date()
  for (const l of lines) {
    const packSize = l.pack_size as number
    const paidPacks = num(l.qty_packs)
    const totalPacks = paidPacks + num(l.bonus_packs)
    const units = packsToUnits(totalPacks, packSize)
    const cost = num(l.cost_per_pack)
    const effectivePackCost = totalPacks ? (cost * paidPacks) / totalPacks : cost   // bonus stock lowers the average
    const prevUnits = Math.max(l.on_hand as number, 0)
    const prevAvg = numOrNull(l.old_avg) ?? numOrNull(l.old_cost) ?? effectivePackCost
    const newAvg = prevUnits + units > 0 ? (prevUnits * prevAvg + units * effectivePackCost) / (prevUnits + units) : effectivePackCost
    await postMovements(tx, [{
      itemId: l.item_id, kind: 'receipt', qtyUnits: units, unitCost: effectivePackCost / packSize,
      refType: 'supplier_invoice', refId: invoiceId, occurredAt,
    }], { userId })
    const retail = l.update_retail ? priceFor(settings, cost, numOrNull(l.markup_override), numOrNull(l.vat_rate)) : num(l.old_retail)
    await tx`
      update items set cost_per_pack = ${cost}, avg_cost_per_pack = ${Math.round(newAvg * 10000) / 10000},
             retail_per_pack = ${retail}, supplier_id = ${inv.supplier_id},
             status = case when status = 'dormant' then 'active' else status end, updated_at = now()
       where id = ${l.item_id}`
    if (cost !== numOrNull(l.old_cost) || retail !== num(l.old_retail)) {
      await tx`insert into price_history (tenant_id, item_id, cost_per_pack, retail_per_pack, effective_from, source, user_id)
               values (current_setting('app.tenant_id')::uuid, ${l.item_id}, ${cost}, ${retail}, ${occurredAt}, 'receipt', ${userId ?? null})`
    }
  }
  await tx`update supplier_invoices set status = 'posted', posted_at = now(), posted_by = ${userId ?? null} where id = ${invoiceId}`
  await audit(tx, userId, 'post', 'supplier_invoice', invoiceId, { lines: lines.length })
}
