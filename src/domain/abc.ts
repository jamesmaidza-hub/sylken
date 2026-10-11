import { num, type Tx } from '../db/index.js'

/**
 * ABC (Pareto) ranking of items. Items are ranked by sales value or gross profit, best first, and their
 * place in the ranking decides the class: the top `aPct` % of ranked items are A, up to `bPct` % (cumulative,
 * so 20 and 50 for a 20/30/50 split) are B, the rest C. Items with no sales in the period are class "-"
 * (not ranked) and listed last.
 *
 * Two sources: the shop's own trading (till sales that are not scripts, plus dispensed scripts, so a
 * script paid at the till is counted once) over the last `days`, or the sales snapshot imported from
 * the old system.
 */

/**
 * Where the ABC classes should sit. A items belong in the fastest shelf, B in the next, and C items
 * should not take up either. Bins holding stock that is kept somewhere special are never touched.
 */
export const SLOTTING = {
  A: 'TOP100',
  B: 'TOP200',
  locked: ['FRIDGE', 'SCH', 'CLASSA', 'ARV', 'DISP', 'TILL', 'OTC-TILL', 'INACTIVE', 'INJECTION', 'INJECTIONS', 'DELIVERY'],
} as const

export interface SlotMove { itemId: string; from: string | null; row: AbcRow; reason: string }
export interface SlotSuggestions {
  /** Moves into a prime bin, keyed by the bin they go to. */
  forward: Map<string, SlotMove[]>
  /** Class C items sitting in a prime bin; the shop picks where they go. */
  back: SlotMove[]
  locked: number
  ok: number
}

/** Moves that would put ranked items on the shelf their class calls for. Unranked items are left alone. */
export function slotSuggestions(rows: AbcRow[]): SlotSuggestions {
  const lock = new Set<string>(SLOTTING.locked)
  const prime = [SLOTTING.A, SLOTTING.B] as string[]
  const out: SlotSuggestions = { forward: new Map(), back: [], locked: 0, ok: 0 }
  const add = (to: string, m: SlotMove) => out.forward.set(to, [...(out.forward.get(to) ?? []), m])
  for (const r of rows) {
    if (r.cls === '-') continue
    if (r.bins.some((b) => lock.has(b.toUpperCase()))) { out.locked++; continue }
    const inA = r.bins.includes(SLOTTING.A), inB = r.bins.includes(SLOTTING.B)
    const from = r.bins[0] ?? null
    if (r.cls === 'A') {
      if (inA) out.ok++
      else add(SLOTTING.A, { itemId: r.itemId, from: inB ? SLOTTING.B : from, row: r, reason: `class A, rank ${r.rank}` })
    } else if (r.cls === 'B') {
      if (inA || inB) out.ok++
      else add(SLOTTING.B, { itemId: r.itemId, from, row: r, reason: `class B, rank ${r.rank}` })
    } else {
      const inPrime = r.bins.find((b) => prime.includes(b))
      if (inPrime) out.back.push({ itemId: r.itemId, from: inPrime, row: r, reason: `class C, rank ${r.rank}, in ${inPrime}` })
      else out.ok++
    }
  }
  return out
}

export type AbcBasis = 'sales' | 'gp'
export type AbcSource = { kind: 'live'; days: number } | { kind: 'imported'; label: string }

export interface AbcRow {
  rank: number | null
  cls: 'A' | 'B' | 'C' | '-'
  itemId: string
  stockCode: string
  description: string
  packSize: number
  status: string
  bins: string[]
  onHandUnits: number
  qtyUnits: number
  sales: number          // excl VAT
  cost: number
  gp: number
  value: number          // the figure ranked on
  share: number          // % of the total
  cumulative: number     // running % of the total
}

export interface AbcResult {
  rows: AbcRow[]
  total: number
  counts: Record<'A' | 'B' | 'C' | '-', number>
  shares: Record<'A' | 'B' | 'C', number>
  period: string
}

export interface ImportedPeriod { label: string; from: string; to: string; items: number }

/** The imported sales snapshots available, newest first. */
export async function importedPeriods(tx: Tx): Promise<ImportedPeriod[]> {
  const rows = await tx`
    select source, period_from::text as f, period_to::text as t, count(*)::int as n
      from abc_sales_snapshot group by source, period_from, period_to order by period_to desc`
  return rows.map((r) => ({ label: r.source as string, from: r.f as string, to: r.t as string, items: r.n as number }))
}

export async function abcRanking(
  tx: Tx,
  opts: { source: AbcSource; basis: AbcBasis; aPct: number /* top % of items */; bPct: number /* cumulative % of items */; status?: string[] },
): Promise<AbcResult> {
  const statuses = opts.status ?? ['active', 'quarantined']
  let period: string
  let sold
  if (opts.source.kind === 'live') {
    const since = new Date(Date.now() - opts.source.days * 86_400_000)
    period = `last ${opts.source.days} days of trading`
    sold = await tx`
      select item_id, sum(qty) as qty, sum(excl) as excl, sum(cost) as cost from (
        select sl.item_id, sl.qty_units as qty, sl.line_total - sl.line_vat as excl, sl.qty_units * coalesce(sl.unit_cost, 0) as cost
          from sale_lines sl join sales s on s.id = sl.sale_id
         where s.occurred_at >= ${since} and sl.script_line_id is null
        union all
        select l.item_id, l.qty_units, l.line_total - l.line_vat, l.qty_units * coalesce(l.unit_cost, 0)
          from script_lines l join scripts sc on sc.id = l.script_id
         where sc.status = 'dispensed' and sc.dispensed_at >= ${since}
      ) x group by item_id`
  } else {
    const [p] = await tx`select min(period_from)::text as f, max(period_to)::text as t from abc_sales_snapshot where source = ${opts.source.label}`
    period = p?.f ? `${p.f} to ${p.t}, imported (${opts.source.label})` : `imported (${opts.source.label})`
    sold = await tx`
      select item_id, sum(qty_units) as qty, sum(sales_excl) as excl, sum(cost) as cost
        from abc_sales_snapshot where source = ${opts.source.label} group by item_id`
  }
  const by = new Map(sold.map((r) => [r.item_id as string, r]))

  const items = await tx`
    select i.id, i.stock_code, i.description, i.pack_size, i.status, coalesce(s.on_hand_units, 0) as on_hand_units,
           coalesce((select array_agg(bn.name order by ib.position) from item_bins ib join bins bn on bn.id = ib.bin_id where ib.item_id = i.id), '{}') as bins
      from items i left join stock_levels s on s.item_id = i.id
     where i.status = any(${statuses})`

  const all: AbcRow[] = items.map((i) => {
    const r = by.get(i.id as string)
    const sales = r ? num(r.excl) : 0
    const cost = r ? num(r.cost) : 0
    const gp = sales - cost
    return {
      rank: null, cls: '-' as const, itemId: i.id as string, stockCode: i.stock_code as string, description: i.description as string,
      packSize: i.pack_size as number, status: i.status as string, bins: i.bins as string[], onHandUnits: i.on_hand_units as number,
      qtyUnits: r ? num(r.qty) : 0, sales, cost, gp, value: opts.basis === 'gp' ? gp : sales, share: 0, cumulative: 0,
    }
  })

  const ranked = all.filter((r) => r.value > 0).sort((a, b) => b.value - a.value || a.description.localeCompare(b.description))
  const rest = all.filter((r) => !(r.value > 0)).sort((a, b) => a.description.localeCompare(b.description))
  const total = ranked.reduce((n, r) => n + r.value, 0)
  // Classes are cut by how many items there are, not by income: the top aPct % of ranked items are A,
  // up to bPct % (cumulative) are B, the rest C. With a 20/30/50 split the A items usually bring in about 80% of income.
  const aCut = Math.ceil((ranked.length * opts.aPct) / 100)
  const bCut = Math.ceil((ranked.length * opts.bPct) / 100)
  let run = 0
  ranked.forEach((r, i) => {
    r.rank = i + 1
    run += r.value
    r.share = total ? (r.value / total) * 100 : 0
    r.cumulative = total ? (run / total) * 100 : 0
    r.cls = i < aCut ? 'A' : i < bCut ? 'B' : 'C'
  })

  const counts = { A: 0, B: 0, C: 0, '-': rest.length }
  const shares = { A: 0, B: 0, C: 0 }
  for (const r of ranked) { counts[r.cls as 'A' | 'B' | 'C']++; shares[r.cls as 'A' | 'B' | 'C'] += r.share }
  return { rows: [...ranked, ...rest], total, counts, shares, period }
}
