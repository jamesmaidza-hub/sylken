import type { Tx } from '../db/index.js'
import { num, numOrNull } from '../db/index.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'
import { getSettings } from './settings.js'
import { unitsToPacks } from './units.js'

export interface OrderLine {
  itemId: string
  stockCode: string
  description: string
  packSize: number
  onHandUnits: number
  minUnits: number
  maxUnits: number
  orderUnits: number
  orderPacks: number         // exact, may be fractional (Compharm shows this)
  orderPacksWhole: number    // rounded up to whole packs, what you'd actually order
  costPerPack: number | null
  retailPerPack: number
  orderValue: number         // whole packs x cost
  bins: string[]
  supplierId: string | null
}

/**
 * Min/max order report, the same rule Compharm uses: every item at or below its minimum,
 * ordering up to its maximum (order = max - on hand, never below zero).
 */
export async function minMaxOrderReport(tx: Tx, opts: { supplierId?: string; binName?: string } = {}): Promise<OrderLine[]> {
  const rows = await tx`
    select i.id, i.stock_code, i.description, i.pack_size, i.cost_per_pack, i.retail_per_pack, i.supplier_id,
           s.on_hand_units, s.min_units, s.max_units,
           coalesce((select array_agg(bn.name order by ib.position) from item_bins ib join bins bn on bn.id = ib.bin_id where ib.item_id = i.id), '{}') as bins
      from stock_levels s join items i on i.id = s.item_id
     where s.min_units is not null and s.max_units is not null
       and i.status in ('active','quarantined')
       and s.on_hand_units <= s.min_units
       and (${opts.supplierId ?? null}::uuid is null or i.supplier_id = ${opts.supplierId ?? null})
       and (${opts.binName ?? null}::text is null or exists (select 1 from item_bins ib join bins bn on bn.id = ib.bin_id where ib.item_id = i.id and bn.name = ${opts.binName ?? null}))
     order by i.description`
  return rows.map((r) => {
    // Compharm lists every item at or below min, even when that orders 0 (min = max = on hand).
    const orderUnits = Math.max(Math.round((num(r.max_units) - r.on_hand_units) * 1000) / 1000, 0)
    const whole = Math.ceil(orderUnits / r.pack_size - 1e-9)
    const cost = r.cost_per_pack === null ? null : num(r.cost_per_pack)
    return {
      itemId: r.id, stockCode: r.stock_code, description: r.description, packSize: r.pack_size,
      onHandUnits: r.on_hand_units, minUnits: num(r.min_units), maxUnits: num(r.max_units), orderUnits,
      orderPacks: unitsToPacks(orderUnits, r.pack_size), orderPacksWhole: whole,
      costPerPack: cost, retailPerPack: num(r.retail_per_pack), orderValue: (cost ?? 0) * whole,
      bins: r.bins, supplierId: r.supplier_id,
    }
  })
}

export interface MinMaxSuggestion {
  itemId: string
  stockCode: string
  description: string
  packSize: number
  soldUnits: number
  aduUnits: number           // average daily usage
  currentMin: number | null
  currentMax: number | null
  currentSource: string | null
  suggestedMin: number
  suggestedMax: number
}

/**
 * Suggest min/max from average daily usage over the last N full months:
 * min = ADU x min days, max = ADU x max days (tenant settings), rounded up.
 * Uses imported history plus sylken's own sales and dispensing.
 */
export async function suggestMinMax(tx: Tx, asOf = new Date()): Promise<MinMaxSuggestion[]> {
  const s = await getSettings(tx)
  const end = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1))            // start of current month
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - s.minmaxUsageMonths, 1))
  const days = (end.getTime() - start.getTime()) / 86_400_000
  const rows = await tx`
    with usage as (
      select item_id, sum(sold_units) as sold from usage_history
       where period >= ${start} and period < ${end} group by item_id
      union all
      select item_id, -sum(qty_units) from stock_movements
       where kind in ('sale','dispense','sale_return') and occurred_at >= ${start} and occurred_at < ${end} group by item_id
    )
    select i.id, i.stock_code, i.description, i.pack_size, sum(u.sold) as sold, s.min_units, s.max_units, s.minmax_source
      from usage u join items i on i.id = u.item_id left join stock_levels s on s.item_id = i.id
     where i.status in ('active','quarantined')
     group by i.id, s.min_units, s.max_units, s.minmax_source
    having sum(u.sold) > 0
     order by i.description`
  return rows.map((r) => {
    const sold = num(r.sold)
    const adu = sold / days
    const min = Math.ceil(adu * s.minmaxMinDays - 1e-9)
    return {
      itemId: r.id, stockCode: r.stock_code, description: r.description, packSize: r.pack_size,
      soldUnits: sold, aduUnits: Math.round(adu * 1000) / 1000,
      currentMin: numOrNull(r.min_units), currentMax: numOrNull(r.max_units), currentSource: r.minmax_source,
      suggestedMin: min, suggestedMax: Math.max(Math.ceil(adu * s.minmaxMaxDays - 1e-9), min + 1),
    }
  })
}

/**
 * Apply suggestions. Levels set by hand or imported from Compharm are kept unless overwrite is true.
 */
export async function applyMinMaxSuggestions(tx: Tx, opts: { overwrite?: boolean; itemIds?: string[] } = {}, userId?: string) {
  const suggestions = await suggestMinMax(tx)
  let applied = 0
  for (const sug of suggestions) {
    if (opts.itemIds && !opts.itemIds.includes(sug.itemId)) continue
    if (!opts.overwrite && sug.currentSource && sug.currentSource !== 'calculated') continue
    await setMinMax(tx, sug.itemId, sug.suggestedMin, sug.suggestedMax, 'calculated')
    applied++
  }
  await audit(tx, userId, 'apply', 'minmax_suggestions', null, { applied, overwrite: !!opts.overwrite })
  return applied
}

export async function setMinMax(tx: Tx, itemId: string, minUnits: number | null, maxUnits: number | null, source: 'manual' | 'calculated' | 'imported' = 'manual') {
  if ((minUnits === null) !== (maxUnits === null)) throw new DomainError('set both min and max, or clear both')
  if (minUnits !== null && maxUnits !== null) {
    if (!Number.isFinite(minUnits) || !Number.isFinite(maxUnits) || minUnits < 0) throw new DomainError('min and max must be zero or more')
    if (maxUnits < minUnits) throw new DomainError('max must be at least min')
  }
  await tx`
    insert into stock_levels (tenant_id, item_id, on_hand_units, min_units, max_units, minmax_source)
    values (current_setting('app.tenant_id')::uuid, ${itemId}, 0, ${minUnits}, ${maxUnits}, ${minUnits === null ? null : source})
    on conflict (item_id) do update set min_units = excluded.min_units, max_units = excluded.max_units,
                                        minmax_source = excluded.minmax_source, updated_at = now()`
}
