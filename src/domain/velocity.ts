import { num, type Tx } from '../db/index.js'

/**
 * Sales velocity from weekly sales snapshots (Compharm's "Stock Usage" report run one week at a time and
 * imported with importAbcSales). For each item: how fast it sells, how many weeks it sold, which weeks look
 * like an empty shelf rather than no demand, whether sales are rising or falling, and how much they swing
 * from week to week. From that, just-in-time min/max levels per ABC class.
 *
 * Quantities here are in packs, the way the shop orders.
 */

export type Cls = 'A' | 'B' | 'C'
export type Trend = 'rising' | 'flat' | 'falling' | '-'

/** Days of stock to hold per class: order when stock falls to min, up to max. */
export type ClassDays = Record<Cls, { min: number; max: number }>

/** A: small orders every day (just in time). B: weekly. C: every two to four weeks. */
export const DEFAULT_DAYS: ClassDays = { A: { min: 2, max: 4 }, B: { min: 7, max: 14 }, C: { min: 14, max: 28 } }

/** A week with no sales counts as a likely empty shelf when the item's other weeks average at least this many packs. */
export const EMPTY_WEEK_MIN_AVG = 3

/** Safety stock covers about 19 weeks in 20 (one-sided 95%). */
const Z = 1.65

export interface WeekStats {
  perDay: number
  perWeek: number
  weeksSold: number
  /** Indexes (oldest first) of weeks with no sales that look like an empty shelf. */
  emptyWeeks: number[]
  /** Packs probably lost in those weeks, at the item's usual rate. */
  lostPacks: number
  trend: Trend
  /** Second half of the weeks against the first half, %; null when there is too little to say. */
  trendPct: number | null
  /** Standard deviation of weekly sales over their mean; 0 is perfectly steady. */
  swing: number
  weeklySd: number
}

const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp

/** Statistics for one item's weekly sales in packs, oldest week first. */
export function weekStats(weeks: number[]): WeekStats {
  const n = weeks.length
  const total = weeks.reduce((s, w) => s + w, 0)
  const perWeek = n ? total / n : 0
  const sd = n > 1 ? Math.sqrt(weeks.reduce((s, w) => s + (w - perWeek) ** 2, 0) / (n - 1)) : 0

  const emptyWeeks: number[] = []
  let lostPacks = 0
  weeks.forEach((w, i) => {
    if (w > 0 || n < 3) return
    const others = weeks.filter((_, j) => j !== i && weeks[j] > 0)
    const usual = others.length ? others.reduce((s, x) => s + x, 0) / others.length : 0
    if (others.length >= n / 2 && usual >= EMPTY_WEEK_MIN_AVG) { emptyWeeks.push(i); lostPacks += usual }
  })

  let trend: Trend = '-'
  let trendPct: number | null = null
  if (n >= 4 && total >= 4) {
    const half = Math.floor(n / 2)
    const first = weeks.slice(0, half).reduce((s, w) => s + w, 0) / half
    const second = weeks.slice(n - half).reduce((s, w) => s + w, 0) / half
    trendPct = first > 0 ? ((second - first) / first) * 100 : second > 0 ? 100 : 0
    trend = trendPct > 25 ? 'rising' : trendPct < -25 ? 'falling' : 'flat'
    trendPct = round(trendPct, 1)
  }

  return {
    perDay: round(perWeek / 7), perWeek: round(perWeek), weeksSold: weeks.filter((w) => w > 0).length,
    emptyWeeks, lostPacks: round(lostPacks, 1), trend, trendPct,
    swing: perWeek > 0 ? round(sd / perWeek, 2) : 0, weeklySd: round(sd),
  }
}

/**
 * Just-in-time levels in packs. Min covers the class's min days at the usual rate plus safety stock for the
 * item's own week-to-week swing; max is the class's max days, at least one more than min. Class C items that
 * sold one pack or less in the whole period are ordered only when a customer asks (0 / 0).
 */
export function jitLevels(cls: Cls, s: Pick<WeekStats, 'perDay' | 'weeklySd'>, totalPacks: number, days: ClassDays = DEFAULT_DAYS) {
  if (cls === 'C' && totalPacks <= 1) return { min: 0, max: 0, onRequest: true }
  const d = days[cls]
  const dailySd = s.weeklySd / Math.sqrt(7)
  const min = Math.max(1, Math.ceil(s.perDay * d.min + Z * dailySd * Math.sqrt(d.min) - 1e-9))
  const max = Math.max(min + 1, Math.ceil(s.perDay * d.max - 1e-9))
  return { min, max, onRequest: false }
}

export interface VelocityRow extends WeekStats {
  rank: number
  cls: Cls
  itemId: string
  stockCode: string
  description: string
  packSize: number
  onHandPacks: number
  costPerPack: number | null
  /** Packs sold each week, oldest first. */
  weeks: number[]
  totalPacks: number
  sales: number          // excl VAT, all weeks
  min: number
  max: number
  onRequest: boolean
  status: 'out' | 'negative' | 'reorder' | 'ok' | 'overstocked' | 'on request'
  orderPacks: number
  orderValue: number
}

export interface WeekPeriod { from: string; to: string }
export interface VelocityResult { rows: VelocityRow[]; weeks: WeekPeriod[]; source: string }

/** Imported sources that hold weekly snapshots, with how many weeks each has. */
export async function weeklySources(tx: Tx): Promise<{ label: string; weeks: number; from: string; to: string }[]> {
  const rows = await tx`
    select source, count(distinct (period_from, period_to))::int as n, min(period_from)::text as f, max(period_to)::text as t
      from abc_sales_snapshot where period_to - period_from between 5 and 7
     group by source order by max(period_to) desc`
  return rows.map((r) => ({ label: r.source as string, weeks: r.n as number, from: r.f as string, to: r.t as string }))
}

/**
 * Velocity for the last `weeks` weekly snapshots of one source. Items are classed A/B/C on sales value over
 * those weeks, split by item count like the ABC list (default 20/30/50).
 */
export async function salesVelocity(
  tx: Tx,
  opts: { source: string; weeks?: number; aPct?: number; bPct?: number; days?: ClassDays },
): Promise<VelocityResult> {
  const periods = await tx`
    select distinct period_from::text as f, period_to::text as t from abc_sales_snapshot
     where source = ${opts.source} and period_to - period_from between 5 and 7
     order by t desc limit ${opts.weeks ?? 8}`
  const weeks: WeekPeriod[] = periods.map((p) => ({ from: p.f as string, to: p.t as string })).reverse()
  if (!weeks.length) return { rows: [], weeks, source: opts.source }
  const index = new Map(weeks.map((w, i) => [`${w.from}|${w.to}`, i]))

  const sold = await tx`
    select s.item_id, s.period_from::text as f, s.period_to::text as t, s.qty_units, s.sales_excl,
           i.stock_code, i.description, i.pack_size, i.cost_per_pack, coalesce(l.on_hand_units, 0) as on_hand_units
      from abc_sales_snapshot s join items i on i.id = s.item_id left join stock_levels l on l.item_id = i.id
     where s.source = ${opts.source} and s.period_from >= ${weeks[0].from} and s.period_to <= ${weeks[weeks.length - 1].to}`

  const byItem = new Map<string, { r: (typeof sold)[number]; weeks: number[]; sales: number }>()
  for (const r of sold) {
    const w = index.get(`${r.f}|${r.t}`)
    if (w === undefined) continue
    const e = byItem.get(r.item_id) ?? { r, weeks: weeks.map(() => 0), sales: 0 }
    e.weeks[w] += num(r.qty_units) / (r.pack_size as number)
    e.sales += num(r.sales_excl)
    byItem.set(r.item_id, e)
  }

  const ranked = [...byItem.values()].filter((e) => e.sales > 0 || e.weeks.some((w) => w > 0))
    .sort((a, b) => b.sales - a.sales || (a.r.description as string).localeCompare(b.r.description as string))
  const aCut = Math.ceil((ranked.length * (opts.aPct ?? 20)) / 100)
  const bCut = Math.ceil((ranked.length * (opts.bPct ?? 50)) / 100)

  const rows = ranked.map((e, i): VelocityRow => {
    const cls: Cls = i < aCut ? 'A' : i < bCut ? 'B' : 'C'
    const packWeeks = e.weeks.map((w) => round(w))
    const stats = weekStats(packWeeks)
    const totalPacks = round(packWeeks.reduce((s, w) => s + w, 0))
    const lv = jitLevels(cls, stats, totalPacks, opts.days)
    const onHand = round((e.r.on_hand_units as number) / (e.r.pack_size as number))
    const cost = e.r.cost_per_pack === null ? null : num(e.r.cost_per_pack)
    const status: VelocityRow['status'] = lv.onRequest ? 'on request'
      : onHand < 0 ? 'negative' : onHand === 0 ? 'out' : onHand <= lv.min ? 'reorder' : onHand > lv.max * 2 ? 'overstocked' : 'ok'
    const orderPacks = !lv.onRequest && onHand <= lv.min ? Math.ceil(lv.max - Math.max(onHand, 0) - 1e-9) : 0
    return {
      ...stats, rank: i + 1, cls, itemId: e.r.item_id as string, stockCode: e.r.stock_code as string,
      description: e.r.description as string, packSize: e.r.pack_size as number, onHandPacks: onHand, costPerPack: cost,
      weeks: packWeeks, totalPacks, sales: round(e.sales, 2), min: lv.min, max: lv.max, onRequest: lv.onRequest,
      status, orderPacks, orderValue: round(orderPacks * (cost ?? 0), 2),
    }
  })
  return { rows, weeks, source: opts.source }
}
