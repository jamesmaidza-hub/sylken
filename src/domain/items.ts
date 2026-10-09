import type { Tx } from '../db/index.js'
import { num, numOrNull } from '../db/index.js'
import { isGtin } from './barcodes.js'
import { DomainError } from './errors.js'
import { gpPct, markupPct, retailFromCost } from './pricing.js'
import { getSettings, type Settings } from './settings.js'

export interface Item {
  id: string
  stockCode: string
  description: string
  packSize: number
  packSizeKnown: boolean
  sellLoose: boolean
  costPerPack: number | null
  avgCostPerPack: number | null
  retailPerPack: number
  vatRate: number | null
  markupOverride: number | null
  schedule: number | null
  status: 'active' | 'dormant' | 'quarantined' | 'discontinued'
  statusReason: string | null
  supplierId: string | null
  barcodes: string[]
  bins: string[]
  onHandUnits: number
  minUnits: number | null
  maxUnits: number | null
  minmaxSource: string | null
  externalRefs: Record<string, unknown>
}

const select = (tx: Tx) => tx`
  select i.*, coalesce(s.on_hand_units, 0) as on_hand_units, s.min_units, s.max_units, s.minmax_source,
         coalesce((select array_agg(b.barcode order by b.barcode) from item_barcodes b where b.item_id = i.id), '{}') as barcodes,
         coalesce((select array_agg(bn.name order by ib.position) from item_bins ib join bins bn on bn.id = ib.bin_id where ib.item_id = i.id), '{}') as bins
    from items i left join stock_levels s on s.item_id = i.id`

function toItem(r: any): Item {
  return {
    id: r.id, stockCode: r.stock_code, description: r.description, packSize: r.pack_size,
    packSizeKnown: r.pack_size_known, sellLoose: r.sell_loose,
    costPerPack: numOrNull(r.cost_per_pack), avgCostPerPack: numOrNull(r.avg_cost_per_pack),
    retailPerPack: num(r.retail_per_pack), vatRate: numOrNull(r.vat_rate), markupOverride: numOrNull(r.markup_override),
    schedule: r.schedule, status: r.status, statusReason: r.status_reason, supplierId: r.supplier_id,
    barcodes: r.barcodes, bins: r.bins, onHandUnits: r.on_hand_units, minUnits: numOrNull(r.min_units), maxUnits: numOrNull(r.max_units),
    minmaxSource: r.minmax_source, externalRefs: r.external_refs,
  }
}

export async function getItem(tx: Tx, id: string): Promise<Item | null> {
  const [r] = await tx`${select(tx)} where i.id = ${id}`
  return r ? toItem(r) : null
}

/** Exact barcode or stock code first, then description match. Dormant items only when asked. */
export async function findByCode(tx: Tx, code: string): Promise<Item | null> {
  const c = code.trim()
  const [r] = await tx`${select(tx)}
     where i.stock_code = ${c} or i.id = (select item_id from item_barcodes where barcode = ${c})
     limit 1`
  return r ? toItem(r) : null
}

export async function searchItems(
  tx: Tx,
  q: string,
  opts: { includeDormant?: boolean; status?: string; limit?: number; offset?: number } = {},
): Promise<Item[]> {
  const term = q.trim()
  const limit = opts.limit ?? 50
  const statuses = opts.status ? [opts.status] : opts.includeDormant ? ['active', 'dormant', 'quarantined', 'discontinued'] : ['active', 'quarantined']
  if (!term) {
    return (await tx`${select(tx)} where i.status = any(${statuses}) order by i.description limit ${limit} offset ${opts.offset ?? 0}`).map(toItem)
  }
  const exact = await findByCode(tx, term)
  if (exact) return [exact]
  const words = term.toUpperCase().split(/\s+/).filter(Boolean)
  // Built with a parameter per word so every word must appear somewhere in the description.
  const params = words.map((w) => `%${w}%`)
  const where = params.map((_, n) => `upper(i.description) like $${n + 2}`).join(' and ')
  const res = await tx.unsafe(
    `select i.*, coalesce(s.on_hand_units, 0) as on_hand_units, s.min_units, s.max_units, s.minmax_source,
            coalesce((select array_agg(b.barcode order by b.barcode) from item_barcodes b where b.item_id = i.id), '{}') as barcodes,
            coalesce((select array_agg(bn.name order by ib.position) from item_bins ib join bins bn on bn.id = ib.bin_id where ib.item_id = i.id), '{}') as bins
       from items i left join stock_levels s on s.item_id = i.id
      where i.status = any($1) and ${where}
      order by (i.status = 'dormant'), (upper(i.description) like $${params.length + 2}) desc, i.description
      limit ${Number(limit)} offset ${Number(opts.offset ?? 0)}`,
    [statuses, ...params, `${words[0]}%`] as any[],
  )
  return res.map(toItem)
}

export interface ItemInput {
  stockCode: string
  description: string
  packSize?: number
  sellLoose?: boolean
  costPerPack?: number | null
  retailPerPack?: number | null      // null/undefined = calculate from cost and markup
  vatRate?: number | null
  markupOverride?: number | null
  schedule?: number | null
  status?: Item['status']
  supplierId?: string | null
  barcodes?: string[]
  bins?: string[]
}

export function priceFor(settings: Settings, cost: number, markupOverride: number | null, vatRate: number | null) {
  return retailFromCost(cost, markupOverride ?? settings.defaultMarkup, vatRate ?? settings.vatRate, settings.retailRounding)
}

export function itemMargins(settings: Settings, item: Pick<Item, 'costPerPack' | 'retailPerPack' | 'vatRate'>) {
  return {
    markupPct: markupPct(item.costPerPack, item.retailPerPack),
    gpPct: gpPct(item.costPerPack, item.retailPerPack, item.vatRate ?? settings.vatRate),
  }
}

function validate(settings: Settings, input: Partial<ItemInput>) {
  if (input.stockCode !== undefined && !input.stockCode.trim()) throw new DomainError('stock code is required')
  if (input.description !== undefined && !input.description.trim()) throw new DomainError('description is required')
  if (input.packSize !== undefined && (!Number.isInteger(input.packSize) || input.packSize < 1)) throw new DomainError('pack size must be a whole number of 1 or more')
  if (input.costPerPack != null && (input.costPerPack < 0 || input.costPerPack > settings.maxSaneCost)) {
    throw new DomainError(`cost P${input.costPerPack} is outside the allowed range (0 to P${settings.maxSaneCost})`)
  }
  if (input.retailPerPack != null && input.retailPerPack < 0) throw new DomainError('retail cannot be negative')
}

export async function createItem(tx: Tx, input: ItemInput, userId?: string): Promise<Item> {
  const settings = await getSettings(tx)
  validate(settings, input)
  const retail = input.retailPerPack ?? (input.costPerPack != null ? priceFor(settings, input.costPerPack, input.markupOverride ?? null, input.vatRate ?? null) : 0)
  const [row] = await tx`
    insert into items (tenant_id, stock_code, description, pack_size, pack_size_known, sell_loose, cost_per_pack, avg_cost_per_pack,
                       retail_per_pack, vat_rate, markup_override, schedule, status, supplier_id)
    values (current_setting('app.tenant_id')::uuid, ${input.stockCode.trim()}, ${input.description.trim()}, ${input.packSize ?? 1},
            ${input.packSize !== undefined}, ${input.sellLoose ?? false}, ${input.costPerPack ?? null}, ${input.costPerPack ?? null},
            ${retail}, ${input.vatRate ?? null}, ${input.markupOverride ?? null}, ${input.schedule ?? null}, ${input.status ?? 'active'},
            ${input.supplierId ?? null})
    on conflict (tenant_id, stock_code) do nothing
    returning id`
  if (!row) throw new DomainError(`stock code ${input.stockCode} already exists`, 'duplicate', 409)
  const codes = new Set(input.barcodes ?? [])
  if (isGtin(input.stockCode.trim())) codes.add(input.stockCode.trim())
  await setBarcodes(tx, row.id, [...codes])
  if (input.bins) await setBins(tx, row.id, input.bins)
  await tx`insert into price_history (tenant_id, item_id, cost_per_pack, retail_per_pack, effective_from, source, user_id)
           values (current_setting('app.tenant_id')::uuid, ${row.id}, ${input.costPerPack ?? null}, ${retail}, now(), 'manual', ${userId ?? null})`
  await audit(tx, userId, 'create', 'item', row.id, { stockCode: input.stockCode })
  return (await getItem(tx, row.id))!
}

export async function updateItem(tx: Tx, id: string, patch: Partial<ItemInput>, userId?: string): Promise<Item> {
  const settings = await getSettings(tx)
  validate(settings, patch)
  const before = await getItem(tx, id)
  if (!before) throw new DomainError('unknown item', 'not_found', 404)
  const row: Record<string, unknown> = {}
  if (patch.stockCode !== undefined) row.stock_code = patch.stockCode.trim()
  if (patch.description !== undefined) row.description = patch.description.trim()
  if (patch.packSize !== undefined) { row.pack_size = patch.packSize; row.pack_size_known = true }
  if (patch.sellLoose !== undefined) row.sell_loose = patch.sellLoose
  if (patch.costPerPack !== undefined) row.cost_per_pack = patch.costPerPack
  if (patch.retailPerPack !== undefined && patch.retailPerPack !== null) row.retail_per_pack = patch.retailPerPack
  if (patch.vatRate !== undefined) row.vat_rate = patch.vatRate
  if (patch.markupOverride !== undefined) row.markup_override = patch.markupOverride
  if (patch.schedule !== undefined) row.schedule = patch.schedule
  if (patch.supplierId !== undefined) row.supplier_id = patch.supplierId
  if (patch.status !== undefined) { row.status = patch.status; row.status_reason = null }
  if (Object.keys(row).length) {
    if (patch.packSize !== undefined && patch.packSize !== before.packSize && before.onHandUnits !== 0) {
      throw new DomainError('pack size can only change while stock on hand is zero, because stock is counted in units')
    }
    await tx`update items set ${tx(row)}, updated_at = now() where id = ${id}`
  }
  if (patch.barcodes) await setBarcodes(tx, id, patch.barcodes)
  if (patch.bins) await setBins(tx, id, patch.bins)
  const after = (await getItem(tx, id))!
  if (after.costPerPack !== before.costPerPack || after.retailPerPack !== before.retailPerPack) {
    await tx`insert into price_history (tenant_id, item_id, cost_per_pack, retail_per_pack, effective_from, source, user_id)
             values (current_setting('app.tenant_id')::uuid, ${id}, ${after.costPerPack}, ${after.retailPerPack}, now(), 'manual', ${userId ?? null})`
  }
  await audit(tx, userId, 'update', 'item', id, row)
  return after
}

export async function setBarcodes(tx: Tx, itemId: string, barcodes: string[]) {
  const clean = [...new Set(barcodes.map((b) => b.trim()).filter(Boolean))]
  await tx`delete from item_barcodes where item_id = ${itemId} and barcode <> all(${clean})`
  for (const b of clean) {
    const [taken] = await tx`select item_id from item_barcodes where barcode = ${b}`
    if (taken && taken.item_id !== itemId) throw new DomainError(`barcode ${b} already belongs to another item`, 'duplicate', 409)
    await tx`insert into item_barcodes (tenant_id, item_id, barcode) values (current_setting('app.tenant_id')::uuid, ${itemId}, ${b}) on conflict do nothing`
  }
}

export async function setBins(tx: Tx, itemId: string, bins: string[]) {
  await tx`delete from item_bins where item_id = ${itemId}`
  const names = [...new Set(bins.map((b) => b.trim().toUpperCase()).filter(Boolean))]
  for (const [i, name] of names.entries()) {
    const [bin] = await tx`
      insert into bins (tenant_id, name) values (current_setting('app.tenant_id')::uuid, ${name})
      on conflict (tenant_id, name) do update set name = excluded.name returning id`
    await tx`insert into item_bins (tenant_id, item_id, bin_id, position) values (current_setting('app.tenant_id')::uuid, ${itemId}, ${bin.id}, ${i + 1})`
  }
}

/** Re-price items from cost using the markup rule. Returns how many changed. */
export async function repriceItems(tx: Tx, itemIds: string[], userId?: string): Promise<number> {
  const settings = await getSettings(tx)
  const rows = await tx`select id, cost_per_pack, retail_per_pack, markup_override, vat_rate from items where id = any(${itemIds}::uuid[]) and cost_per_pack is not null`
  let changed = 0
  for (const r of rows) {
    const retail = priceFor(settings, num(r.cost_per_pack), numOrNull(r.markup_override), numOrNull(r.vat_rate))
    if (retail === num(r.retail_per_pack)) continue
    await tx`update items set retail_per_pack = ${retail}, updated_at = now() where id = ${r.id}`
    await tx`insert into price_history (tenant_id, item_id, cost_per_pack, retail_per_pack, effective_from, source, user_id)
             values (current_setting('app.tenant_id')::uuid, ${r.id}, ${r.cost_per_pack}, ${retail}, now(), 'reprice', ${userId ?? null})`
    changed++
  }
  return changed
}

export async function audit(tx: Tx, userId: string | undefined | null, action: string, entity: string, entityId: string | null, detail?: unknown) {
  await tx`insert into audit_log (tenant_id, user_id, action, entity, entity_id, detail)
           values (current_setting('app.tenant_id')::uuid, ${userId ?? null}, ${action}, ${entity}, ${entityId}, ${detail === undefined ? null : tx.json(detail as any)})`
}
