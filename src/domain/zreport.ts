import type { Tx } from '../db/index.js'
import { DomainError } from './errors.js'
import { round2 } from './pricing.js'
import type { RunSummary } from './till.js'

/**
 * The bill-and-coin count at cash-up, and the Z-report. When a run is cashed up a Z-report is made: a numbered summary
 * of the run as it stood at that moment (takings, tenders, drops, no-sales, expected against counted, the notes and
 * coins counted, and who rang up what). It is saved as it was and never changed, and the run itself is locked.
 */

/** Pula notes and coins, largest first. Notes are P10 and up; below that are coins (P5, P2, P1, 50t, 25t, 10t, 5t). */
export const cashDenominations = [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05] as const
export const denominationLabel = (d: number) => (d >= 1 ? `P${d}` : `${Math.round(d * 100)}t`)
export const denominationKind = (d: number) => (d >= 10 ? 'Note' : 'Coin')

/** Check a count of notes and coins ({ "200": 1, "0.5": 4 }) and add it up. */
export function cleanBreakdown(input: Record<string, unknown>): { breakdown: Record<string, number>; total: number } {
  const known = (cashDenominations as readonly number[]).map(String)
  for (const k of Object.keys(input)) if (!known.includes(k)) throw new DomainError(`unknown note or coin ${k}`)
  const breakdown: Record<string, number> = {}
  let total = 0
  for (const d of cashDenominations) {
    const raw = input[String(d)]
    const q = raw === undefined || raw === null || raw === '' ? 0 : Number(raw)
    if (!Number.isInteger(q) || q < 0) throw new DomainError(`the number of ${denominationLabel(d)} counted must be a whole number, zero or more`)
    if (q) breakdown[String(d)] = q
    total = round2(total + d * q)
  }
  return { breakdown, total }
}

export interface ZReport {
  zNo: number
  generatedAt: string
  shop: { name: string; vatNumber: string | null }
  shiftId: string                       // the run's id
  runNo: number
  till: { code: string; name: string }
  openedAt: string
  openedBy: string | null
  closedAt: string | null
  closedBy: string | null
  openingFloat: number
  floatKept: number | null
  sales: RunSummary['sales']
  byTender: RunSummary['byTender']
  accountPayments: RunSummary['accountPayments']
  pettyCash: number
  cashDrops: number
  noSales: number
  /** Per counted tender: what the system expected, what was counted, and counted - expected. */
  counts: { tender: string; expected: number; counted: number; variance: number }[]
  totalVariance: number
  cashBreakdown: Record<string, number> | null
  cashiers: { code: string | null; sales: number; total: number }[]
  note: string | null
}

export async function createZReport(
  tx: Tx, s: RunSummary, extra: { cashBreakdown: Record<string, number> | null; cashiers: ZReport['cashiers']; shopName: string; vatNumber: string | null }, userId?: string | null,
): Promise<ZReport> {
  const [c] = await tx`
    insert into tenant_counters (tenant_id, name, value) values (current_setting('app.tenant_id')::uuid, 'z_report', 1)
    on conflict (tenant_id, name) do update set value = tenant_counters.value + 1 returning value`
  const zNo = Number(c.value)
  const counts = s.counts.map((x) => ({ tender: x.tender as string, expected: x.expected, counted: x.counted, variance: round2(x.counted - x.expected) }))
  const z: ZReport = {
    zNo, generatedAt: new Date().toISOString(),
    shop: { name: extra.shopName, vatNumber: extra.vatNumber },
    shiftId: s.id, runNo: s.runNo, till: { code: s.tillCode, name: s.tillName },
    openedAt: new Date(s.openedAt).toISOString(), openedBy: s.openedBy,
    closedAt: s.closedAt ? new Date(s.closedAt).toISOString() : null, closedBy: s.closedBy,
    openingFloat: s.openingFloat, floatKept: s.floatKept,
    sales: s.sales, byTender: s.byTender, accountPayments: s.accountPayments,
    pettyCash: s.pettyCash, cashDrops: s.cashDrops, noSales: s.noSales,
    counts, totalVariance: round2(counts.reduce((a, x) => a + x.variance, 0)),
    cashBreakdown: extra.cashBreakdown, cashiers: extra.cashiers, note: s.note,
  }
  await tx`insert into z_reports (tenant_id, till_run_id, z_no, generated_by, payload)
           values (current_setting('app.tenant_id')::uuid, ${s.id}, ${zNo}, ${userId ?? null}, ${tx.json(z as any)})`
  return z
}

/** The Z-report made when a run was cashed up, exactly as it was then. Null for a run not cashed up (or before Z-reports). */
export async function getZReport(tx: Tx, runId: string): Promise<ZReport | null> {
  const [r] = await tx`select payload from z_reports where till_run_id = ${runId}`
  return r ? (r.payload as ZReport) : null
}
