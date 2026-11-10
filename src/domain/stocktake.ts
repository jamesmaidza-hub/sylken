import { createHash } from 'node:crypto'
import type { Tx } from '../db/index.js'
import { num } from '../db/index.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'
import { parseScanFile } from './scanfile.js'
import { postMovements } from './stock.js'
import { packsToUnits } from './units.js'

/** Start a count for the whole shop or one bin. Expected quantities are frozen now. */
export async function startStockTake(tx: Tx, input: { name: string; binId?: string | null }, userId?: string) {
  const [st] = await tx`
    insert into stock_takes (tenant_id, name, bin_id, started_by)
    values (current_setting('app.tenant_id')::uuid, ${input.name}, ${input.binId ?? null}, ${userId ?? null})
    returning id`
  // Every active item in scope, plus anything dormant that still shows stock.
  await tx`
    insert into stock_take_lines (tenant_id, stock_take_id, item_id, expected_units)
    select i.tenant_id, ${st.id}, i.id, coalesce(s.on_hand_units, 0)
      from items i left join stock_levels s on s.item_id = i.id
     where (i.status in ('active','quarantined') or coalesce(s.on_hand_units, 0) <> 0)
       and (${input.binId ?? null}::uuid is null or exists (select 1 from item_bins ib where ib.item_id = i.id and ib.bin_id = ${input.binId ?? null}))`
  await audit(tx, userId, 'start', 'stock_take', st.id, input)
  return st.id as string
}

async function open(tx: Tx, id: string) {
  const [st] = await tx`select * from stock_takes where id = ${id} for update`
  if (!st) throw new DomainError('unknown stock take', 'not_found', 404)
  if (st.status !== 'counting') throw new DomainError('stock take is closed', 'closed', 409)
  return st
}

/** Record a count. mode 'add' accumulates (scanning the same item on two shelves); 'set' replaces. */
export async function recordCount(tx: Tx, id: string, itemId: string, units: number, mode: 'set' | 'add' = 'set', userId?: string) {
  await open(tx, id)
  if (!Number.isInteger(units) || (units < 0 && mode === 'set')) throw new DomainError('count must be a whole number of units, zero or more')
  // Items found that were not in the snapshot join the count with their current on-hand as expected.
  await tx`
    insert into stock_take_lines (tenant_id, stock_take_id, item_id, expected_units)
    select current_setting('app.tenant_id')::uuid, ${id}, ${itemId}, coalesce((select on_hand_units from stock_levels where item_id = ${itemId}), 0)
    on conflict (stock_take_id, item_id) do nothing`
  const [row] = await tx`
    update stock_take_lines
       set counted_units = case when ${mode} = 'add' then coalesce(counted_units, 0) + ${units} else ${units} end,
           counted_at = now(), counted_by = ${userId ?? null}
     where stock_take_id = ${id} and item_id = ${itemId}
     returning counted_units, expected_units`
  if (row.counted_units < 0) throw new DomainError('count cannot go below zero')
  return { counted: row.counted_units as number, expected: row.expected_units as number }
}

export async function stockTakeSummary(tx: Tx, id: string) {
  const [st] = await tx`select st.*, b.name as bin_name from stock_takes st left join bins b on b.id = st.bin_id where st.id = ${id}`
  if (!st) return null
  const lines = await tx`
    select l.item_id, l.expected_units, l.counted_units, i.stock_code, i.description, i.pack_size,
           coalesce(i.avg_cost_per_pack, i.cost_per_pack, 0) / i.pack_size as unit_cost
      from stock_take_lines l join items i on i.id = l.item_id
     where l.stock_take_id = ${id}
     order by (l.counted_units is not null and l.counted_units <> l.expected_units) desc, i.description`
  let varianceValue = 0
  let counted = 0
  const out = lines.map((l) => {
    const variance = l.counted_units === null ? null : (l.counted_units as number) - (l.expected_units as number)
    if (variance !== null) { counted++; varianceValue += variance * num(l.unit_cost) }
    return {
      itemId: l.item_id as string, stockCode: l.stock_code as string, description: l.description as string, packSize: l.pack_size as number,
      expectedUnits: l.expected_units as number, countedUnits: l.counted_units as number | null, varianceUnits: variance,
      varianceValue: variance === null ? null : variance * num(l.unit_cost),
    }
  })
  return {
    id: st.id as string, name: st.name as string, binName: st.bin_name as string | null, status: st.status as string,
    startedAt: st.started_at as Date, postedAt: st.posted_at as Date | null,
    lines: out, totalLines: out.length, countedLines: counted, varianceValue,
  }
}

/**
 * Post the count. Each counted line moves stock by (counted - expected), so sales made
 * while the count was running are kept. Uncounted lines are left alone unless zeroUncounted.
 */
export async function postStockTake(tx: Tx, id: string, opts: { zeroUncounted?: boolean } = {}, userId?: string) {
  await open(tx, id)
  if (opts.zeroUncounted) {
    await tx`update stock_take_lines set counted_units = 0, counted_at = now(), counted_by = ${userId ?? null}
              where stock_take_id = ${id} and counted_units is null`
  }
  const lines = await tx`
    select l.item_id, l.counted_units - l.expected_units as variance,
           coalesce(i.avg_cost_per_pack, i.cost_per_pack) / i.pack_size as unit_cost
      from stock_take_lines l join items i on i.id = l.item_id
     where l.stock_take_id = ${id} and l.counted_units is not null and l.counted_units <> l.expected_units`
  await postMovements(tx, lines.map((l) => ({
    itemId: l.item_id, kind: 'stocktake' as const, qtyUnits: l.variance as number,
    unitCost: l.unit_cost === null ? null : num(l.unit_cost), refType: 'stock_take', refId: id,
  })), { userId, allowNegative: true })
  await tx`update stock_takes set status = 'posted', posted_at = now(), posted_by = ${userId ?? null} where id = ${id}`
  await audit(tx, userId, 'post', 'stock_take', id, { adjustedLines: lines.length })
  return lines.length
}

export async function cancelStockTake(tx: Tx, id: string, userId?: string) {
  await open(tx, id)
  await tx`update stock_takes set status = 'cancelled' where id = ${id}`
  await audit(tx, userId, 'cancel', 'stock_take', id)
}

// ---------------------------------------------------------------- handheld scanner uploads

export type ScanQtyUnit = 'packs' | 'units'

/** Resolve scanned codes to items in one go: stock code, any barcode, or NAPPI code. */
async function itemsForCodes(tx: Tx, codes: string[]) {
  const out = new Map<string, { id: string; stockCode: string; description: string; packSize: number }>()
  if (!codes.length) return out
  // A 12-digit UPC is the same product as the 13-digit EAN with a leading 0, and the other way round.
  const variants = (c: string) => [c, ...(/^\d{12}$/.test(c) ? ['0' + c] : []), ...(/^0\d{12}$/.test(c) ? [c.slice(1)] : [])]
  const all = [...new Set(codes.flatMap(variants))]
  const rows = await tx`
    select m.code, i.id, i.stock_code, i.description, i.pack_size, m.rank
      from (
        select stock_code as code, id as item_id, 1 as rank from items where stock_code = any(${all})
        union all select barcode, item_id, 2 from item_barcodes where barcode = any(${all})
        union all select nappi_code, id, 3 from items where nappi_code = any(${all})
      ) m join items i on i.id = m.item_id
     order by m.rank`
  const byCode = new Map<string, any>()
  for (const r of rows) if (!byCode.has(r.code)) byCode.set(r.code, r)
  for (const c of codes) {
    const r = variants(c).map((v) => byCode.get(v)).find(Boolean)
    if (r) out.set(c, { id: r.id, stockCode: r.stock_code, description: r.description, packSize: r.pack_size })
  }
  return out
}

/**
 * Upload a handheld's file into a count that is still open. Nothing is counted yet: the upload is
 * kept as pending so someone can check what the file says (and which codes sylken doesn't know)
 * before adding it.
 */
export async function uploadScanFile(
  tx: Tx, stockTakeId: string,
  file: { name: string; text: string }, opts: { qtyUnit: ScanQtyUnit; mode: 'add' | 'set' }, userId?: string,
) {
  await open(tx, stockTakeId)
  if (file.text.length > 5_000_000) throw new DomainError('that file is too big for a scanner file')
  if (file.text.includes('\u0000') || /^PK\u0003\u0004/.test(file.text)) throw new DomainError('that is not a text file. Upload the .txt or .csv file the scanner software saved')
  const parsed = parseScanFile(file.text)
  if (!parsed.rows.length) throw new DomainError('no scans found in that file')
  const sha = createHash('sha256').update(file.text).digest('hex')
  const [dupe] = await tx`select uploaded_at from stock_take_uploads where stock_take_id = ${stockTakeId} and file_sha256 = ${sha} and status = 'added'`
  if (dupe) throw new DomainError('this exact file was already added to this count, so adding it again would count everything twice', 'duplicate', 409)
  const found = await itemsForCodes(tx, parsed.rows.map((r) => r.code))
  const unknown = parsed.rows.filter((r) => !found.has(r.code)).map((r) => ({ code: r.code, qty: r.qty, lines: r.lines }))
  const matched = new Set(parsed.rows.filter((r) => found.has(r.code)).map((r) => found.get(r.code)!.id)).size
  const [row] = await tx`
    insert into stock_take_uploads (tenant_id, stock_take_id, file_name, file_sha256, raw_text, qty_unit, mode, scans, matched_items,
                                    unknown_codes, skipped_lines, uploaded_by)
    values (current_setting('app.tenant_id')::uuid, ${stockTakeId}, ${file.name.slice(0, 200) || 'scanner file'}, ${sha}, ${file.text},
            ${opts.qtyUnit}, ${opts.mode}, ${parsed.scans}, ${matched}, ${tx.json(unknown as any)}, ${tx.json(parsed.skipped as any)}, ${userId ?? null})
    returning id`
  await audit(tx, userId, 'upload', 'stock_take', stockTakeId, { uploadId: row.id, file: file.name, sha256: sha, scans: parsed.scans, matched, unknown: unknown.length })
  return row.id as string
}

/** What a pending (or finished) upload will do to each item's count. */
export async function scanUploadPreview(tx: Tx, uploadId: string) {
  const [u] = await tx`select * from stock_take_uploads where id = ${uploadId}`
  if (!u) return null
  const parsed = parseScanFile(u.raw_text)
  const found = await itemsForCodes(tx, parsed.rows.map((r) => r.code))
  const current = new Map((await tx`select item_id, expected_units, counted_units from stock_take_lines where stock_take_id = ${u.stock_take_id}`)
    .map((l) => [l.item_id as string, l]))
  const byItem = new Map<string, { itemId: string; stockCode: string; description: string; packSize: number; codes: string[]; units: number; fileQty: number }>()
  for (const r of parsed.rows) {
    const it = found.get(r.code)
    if (!it) continue
    const units = u.qty_unit === 'packs' ? packsToUnits(r.qty, it.packSize) : Math.round(r.qty)
    const e = byItem.get(it.id)
    if (e) { e.units += units; e.fileQty += r.qty; e.codes.push(r.code) }
    else byItem.set(it.id, { itemId: it.id, stockCode: it.stockCode, description: it.description, packSize: it.packSize, codes: [r.code], units, fileQty: r.qty })
  }
  const lines = [...byItem.values()].map((l) => {
    const cur = current.get(l.itemId)
    const before = cur?.counted_units ?? null
    const after = u.mode === 'add' ? (before ?? 0) + l.units : l.units
    return { ...l, inCount: !!cur, expectedUnits: cur ? (cur.expected_units as number) : null, countedBefore: before as number | null, countedAfter: after }
  }).sort((a, b) => a.description.localeCompare(b.description))
  return {
    id: u.id as string, stockTakeId: u.stock_take_id as string, fileName: u.file_name as string, status: u.status as string,
    qtyUnit: u.qty_unit as ScanQtyUnit, mode: u.mode as 'add' | 'set', scans: u.scans as number, uploadedAt: u.uploaded_at as Date,
    lines, unknown: u.unknown_codes as { code: string; qty: number; lines: number[] }[], skipped: u.skipped_lines as { line: number; text: string; reason: string }[],
  }
}

/** Add a pending upload's counts to its stock take. Codes sylken doesn't know are left out and listed. */
export async function addScanUpload(tx: Tx, uploadId: string, userId?: string) {
  const [u] = await tx`select * from stock_take_uploads where id = ${uploadId} for update`
  if (!u) throw new DomainError('unknown upload', 'not_found', 404)
  if (u.status !== 'pending') throw new DomainError(`this upload was already ${u.status}`, 'closed', 409)
  await open(tx, u.stock_take_id)
  const p = (await scanUploadPreview(tx, uploadId))!
  for (const l of p.lines) await recordCount(tx, u.stock_take_id, l.itemId, l.units, p.mode, userId)
  await tx`update stock_take_uploads set status = 'added', decided_by = ${userId ?? null}, decided_at = now() where id = ${uploadId}`
    .catch((e: any) => { throw e.code === '23505' ? new DomainError('this exact file was already added to this count', 'duplicate', 409) : e })
  await audit(tx, userId, 'add_upload', 'stock_take', u.stock_take_id, { uploadId, items: p.lines.length, unknown: p.unknown.length })
  return { items: p.lines.length, unknown: p.unknown.length }
}

export async function discardScanUpload(tx: Tx, uploadId: string, userId?: string) {
  const [u] = await tx`select stock_take_id, status from stock_take_uploads where id = ${uploadId} for update`
  if (!u) throw new DomainError('unknown upload', 'not_found', 404)
  if (u.status !== 'pending') throw new DomainError(`this upload was already ${u.status}`, 'closed', 409)
  await tx`update stock_take_uploads set status = 'discarded', decided_by = ${userId ?? null}, decided_at = now() where id = ${uploadId}`
  await audit(tx, userId, 'discard_upload', 'stock_take', u.stock_take_id, { uploadId })
}
