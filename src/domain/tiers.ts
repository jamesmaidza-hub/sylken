import { num, type Tx } from '../db/index.js'
import { soldByItem, type AbcSource } from './abc.js'

/**
 * Stock usage in tiers. Items are ranked by gross profit (or sales) over a period and cut by their
 * share of it: tier A is the few items that together make the first `aShare` % (80 by default), B the
 * next `bShare` % (15), C the rest. Each row also says how fast the item sells, how long the stock on
 * hand lasts at that rate, and whether it is out of stock or negative.
 *
 * From the tiers comes a reorder list that fits a budget: tier A first, best profit first, enough to
 * last the chosen number of weeks, ticked until the money runs out.
 */

export type Tier = 'A' | 'B' | 'C' | '-'
export type TierBasis = 'gp' | 'sales'
/** Which items: all, medicines needing a script (schedule 1 and up), or over the counter. */
export type TierGroup = 'all' | 'rx' | 'otc'

export const DAYS_PER_MONTH = 30.44

export interface TierRow {
  tier: Tier
  rank: number | null
  itemId: string
  stockCode: string
  description: string
  packSize: number
  schedule: number | null
  supplier: string | null
  bins: string[]
  onHandUnits: number
  costPerPack: number | null    // last cost excl VAT
  qtyUnits: number              // sold in the period
  sales: number                 // excl VAT
  cost: number
  gp: number
  value: number                 // the figure ranked on
  share: number                 // % of the group's total
  cumulative: number            // running % of the total, this item included
  perMonthPacks: number         // average packs sold per month
  coverDays: number | null      // days the stock on hand lasts; null when nothing sells
  flag: 'negative' | 'out' | 'low' | null
}

export interface TierOpts {
  source: AbcSource
  basis?: TierBasis
  aShare?: number               // % of profit tier A makes
  bShare?: number               // % tier B makes on top of A
  group?: TierGroup
  bin?: string
  lowDays?: number              // fewer days of cover than this is "low"
}

export interface TierResult {
  rows: TierRow[]
  total: number
  counts: Record<Tier, number>
  shares: Record<'A' | 'B' | 'C', number>
  flags: { out: number; negative: number; low: number }
  period: string
  days: number
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

export async function stockTiers(tx: Tx, opts: TierOpts): Promise<TierResult> {
  const basis = opts.basis ?? 'gp'
  const aShare = opts.aShare ?? 80
  const bShare = opts.bShare ?? 15
  const lowDays = opts.lowDays ?? 7
  const group = opts.group ?? 'all'
  const bin = opts.bin?.trim().toUpperCase() || null

  const { sold, period, days } = await soldByItem(tx, opts.source)
  const by = new Map(sold.map((r) => [r.item_id, r]))

  const items = await tx`
    select i.id, i.stock_code, i.description, i.pack_size, i.schedule, i.cost_per_pack, sp.name as supplier,
           coalesce(s.on_hand_units, 0) as on_hand_units,
           coalesce((select array_agg(bn.name order by ib.position) from item_bins ib join bins bn on bn.id = ib.bin_id where ib.item_id = i.id), '{}') as bins
      from items i
      left join stock_levels s on s.item_id = i.id
      left join suppliers sp on sp.id = i.supplier_id
     where i.status in ('active', 'quarantined')
       and (${group}::text = 'all' or (${group}::text = 'rx' and coalesce(i.schedule, 0) >= 1) or (${group}::text = 'otc' and coalesce(i.schedule, 0) < 1))
       and (${bin}::text is null or exists (select 1 from item_bins ib join bins bn on bn.id = ib.bin_id where ib.item_id = i.id and upper(bn.name) = ${bin}))`

  const all: TierRow[] = items.map((i) => {
    const r = by.get(i.id as string)
    const packSize = i.pack_size as number
    const qtyUnits = r ? num(r.qty) : 0
    const sales = r ? num(r.excl) : 0
    const cost = r ? num(r.cost) : 0
    const gp = sales - cost
    const onHand = num(i.on_hand_units)
    const daily = qtyUnits / days
    const coverDays = daily > 0 ? Math.max(0, onHand) / daily : null
    const flag = qtyUnits <= 0 ? (onHand < 0 ? 'negative' : null)
      : onHand < 0 ? 'negative' : onHand === 0 ? 'out' : coverDays !== null && coverDays < lowDays ? 'low' : null
    return {
      tier: '-' as Tier, rank: null, itemId: i.id as string, stockCode: i.stock_code as string, description: i.description as string,
      packSize, schedule: i.schedule as number | null, supplier: i.supplier as string | null, bins: i.bins as string[],
      onHandUnits: onHand, costPerPack: i.cost_per_pack === null ? null : num(i.cost_per_pack),
      qtyUnits, sales, cost, gp, value: basis === 'gp' ? gp : sales, share: 0, cumulative: 0,
      perMonthPacks: r3((daily * DAYS_PER_MONTH) / packSize), coverDays: coverDays === null ? null : Math.round(coverDays), flag,
    }
  })

  const ranked = all.filter((r) => r.value > 0).sort((a, b) => b.value - a.value || a.description.localeCompare(b.description))
  // Sold, but made no profit (or the cost is wrong): tier C, after the ranked ones.
  const noProfit = all.filter((r) => !(r.value > 0) && r.qtyUnits > 0).sort((a, b) => b.sales - a.sales)
  const unsold = all.filter((r) => !(r.value > 0) && !(r.qtyUnits > 0)).sort((a, b) => a.description.localeCompare(b.description))
  const total = ranked.reduce((n, r) => n + r.value, 0)
  let run = 0
  ranked.forEach((r, i) => {
    // Cut by share of profit: an item is A while the items above it have not yet made aShare %.
    const before = total ? (run / total) * 100 : 0
    run += r.value
    r.rank = i + 1
    r.share = total ? (r.value / total) * 100 : 0
    r.cumulative = total ? (run / total) * 100 : 0
    r.tier = before < aShare ? 'A' : before < aShare + bShare ? 'B' : 'C'
  })
  for (const r of noProfit) r.tier = 'C'

  const rows = [...ranked, ...noProfit, ...unsold]
  const counts: Record<Tier, number> = { A: 0, B: 0, C: 0, '-': 0 }
  const shares = { A: 0, B: 0, C: 0 }
  const flags = { out: 0, negative: 0, low: 0 }
  for (const r of rows) {
    counts[r.tier]++
    if (r.tier !== '-') shares[r.tier] += r.share
    if (r.tier !== '-' && r.flag) flags[r.flag]++
  }
  return { rows, total, counts, shares, flags, period, days }
}

// ---------------------------------------------------------------------------- the weekly order

export interface OrderOpts {
  budget: number
  weeks: number                 // weeks of stock to order up to
  tiers: ('A' | 'B' | 'C')[]
  slowMonths?: number           // one pack lasting longer than this is ordered per script
}

export interface OrderLine {
  row: TierRow
  orderPacks: number
  lineCost: number
  /** Ticked to order: within budget and not set aside. */
  pick: boolean
  runningTotal: number          // of ticked lines, this one included if ticked
  note: string
  /** Set aside: not ticked whatever the budget (order per script, no cost, sells below cost). */
  aside: boolean
}

export interface OrderResult { lines: OrderLine[]; spent: number; picked: number; overBudget: number }

const tierOrder = { A: 0, B: 1, C: 2, '-': 3 } as const

/**
 * The reorder list: every item in the chosen tiers whose stock will not last `weeks`, enough whole
 * packs to last that long, tier A first and the most profit a month first. Lines are ticked while the
 * budget lasts; a line that does not fit is left unticked and smaller lines below it can still fit.
 * Negative stock counts as none (the shelf is empty either way) and is noted for a count.
 */
export function weeklyOrder(rows: TierRow[], days: number, opts: OrderOpts, picks?: { on: Set<string>; packs: Map<string, number> }): OrderResult {
  const slowMonths = opts.slowMonths ?? 3
  const want = new Set(opts.tiers)
  const cand: OrderLine[] = []
  for (const r of rows) {
    if (r.tier === '-' || !want.has(r.tier) || r.qtyUnits <= 0) continue
    const daily = r.qtyUnits / days
    const need = daily * opts.weeks * 7 - Math.max(0, r.onHandUnits)
    if (need <= 0) continue
    let orderPacks = Math.max(1, Math.ceil(need / r.packSize - 1e-9))
    const chosen = picks?.packs.get(r.itemId)
    if (chosen !== undefined && Number.isFinite(chosen) && chosen >= 0) orderPacks = Math.floor(chosen)
    const notes: string[] = []
    let aside = false
    const monthsPerPack = r.perMonthPacks > 0 ? 1 / r.perMonthPacks : Infinity
    if (!r.costPerPack || r.costPerPack <= 0) { aside = true; notes.push('Cost price missing - check before ordering') }
    else if (r.gp < 0) { aside = true; notes.push('Sells below cost - check the price') }
    else if (monthsPerPack > slowMonths) { aside = true; notes.push(`1 pack lasts about ${Math.round(monthsPerPack)} months - order per script`) }
    if (r.onHandUnits < 0) notes.push('Negative stock - count first')
    cand.push({ row: r, orderPacks, lineCost: Math.round(orderPacks * (r.costPerPack ?? 0) * 100) / 100, pick: false, runningTotal: 0, note: notes.join('; '), aside })
  }
  const monthly = (l: OrderLine) => (l.row.gp / days) * DAYS_PER_MONTH
  cand.sort((a, b) => tierOrder[a.row.tier] - tierOrder[b.row.tier] || monthly(b) - monthly(a) || a.row.description.localeCompare(b.row.description))

  let spent = 0
  let overBudget = 0
  for (const l of cand) {
    if (picks) {
      // The person ticked their own lines: keep what they chose, budget or not.
      l.pick = picks.on.has(l.row.itemId) && l.orderPacks > 0
    } else if (!l.aside && l.orderPacks > 0) {
      if (spent + l.lineCost <= opts.budget + 1e-9) l.pick = true
      else { overBudget++; l.note = l.note ? `Over budget; ${l.note}` : 'Over budget' }
    }
    if (l.pick) spent = Math.round((spent + l.lineCost) * 100) / 100
    l.runningTotal = spent
  }
  return { lines: cand, spent, picked: cand.filter((l) => l.pick).length, overBudget }
}
