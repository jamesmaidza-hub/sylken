import type { Tx } from '../db/index.js'
import { num } from '../db/index.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'
import { postMovements } from './stock.js'

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
