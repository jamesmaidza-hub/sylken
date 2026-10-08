import type { OrderLine } from '../domain/minmax.js'

export interface CompharmOrderRow {
  stockCode: string
  orderPacks: number
}

/** Compare sylken's min/max order report with Compharm's, line by line, in packs. */
export function compareMinMax(theirs: CompharmOrderRow[], ours: OrderLine[], tolerancePacks = 0.01) {
  const mine = new Map(ours.map((o) => [o.stockCode, o]))
  const seen = new Set<string>()
  const missing: string[] = []
  const mismatches: { stockCode: string; compharm: number; sylken: number }[] = []
  let matched = 0
  for (const t of theirs) {
    seen.add(t.stockCode)
    const o = mine.get(t.stockCode)
    if (!o) { missing.push(t.stockCode); continue }
    if (Math.abs(o.orderPacks - t.orderPacks) > tolerancePacks) mismatches.push({ stockCode: t.stockCode, compharm: t.orderPacks, sylken: o.orderPacks })
    else matched++
  }
  const extra = ours.filter((o) => !seen.has(o.stockCode)).map((o) => o.stockCode)
  return { compharmLines: theirs.length, sylkenLines: ours.length, matched, missing, extra, mismatches }
}
