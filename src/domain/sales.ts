import type { Tx } from '../db/index.js'
import { num } from '../db/index.js'
import { DomainError } from './errors.js'
import { round2 } from './pricing.js'
import { getSettings } from './settings.js'
import { runSummary, type RunSummary } from './till.js'

/**
 * Sales reports. Dates are trading days in the shop's own time zone (Africa/Gaborone by
 * default), given as YYYY-MM-DD, both ends included.
 */

export interface DayRange { from: string; to: string }

const isoDay = /^\d{4}-\d{2}-\d{2}$/

export function checkRange(r: DayRange) {
  if (!isoDay.test(r.from) || !isoDay.test(r.to)) throw new DomainError('dates must be YYYY-MM-DD')
  if (r.from > r.to) throw new DomainError('the start date is after the end date')
}

/** Today's date in the shop's time zone. */
export function shopToday(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** Start of `from` and start of the day after `to`, in the shop's time zone, as instants. */
export async function bounds(tx: Tx, r: DayRange) {
  checkRange(r)
  const { timezone } = await getSettings(tx)
  const [b] = await tx`
    select (${r.from}::date)::timestamp at time zone ${timezone} as start,
           (${r.to}::date + 1)::timestamp at time zone ${timezone} as end`
  return { start: b.start as Date, end: b.end as Date, timezone }
}

export interface CashAnalysisRow {
  run: RunSummary
  cash: number          // cash taken: sales + account payments - petty cash (float excluded)
  card: number
  cheque: number
  totalTill: number
  counted: number | null
  surplus: number | null
  directBank: number    // EFT straight into the bank
}

/**
 * The cash-up screen for a range of days: one row per till run opened in the range, then the
 * payments, bank deposit and turnover blocks laid out the way POSWin's Sales Summary does.
 */
export async function salesSummary(tx: Tx, range: DayRange & { tillId?: string }) {
  const { start, end } = await bounds(tx, range)
  const runRows = await tx`
    select id from till_runs
     where opened_at >= ${start} and opened_at < ${end} ${range.tillId ? tx`and till_id = ${range.tillId}` : tx``}
     order by opened_at, run_no`
  const runs: RunSummary[] = []
  for (const r of runRows) runs.push((await runSummary(tx, r.id))!)

  const rows: CashAnalysisRow[] = runs.map((run) => {
    const cash = round2(run.byTender.cash + run.accountPayments.cash - run.pettyCash)
    const card = run.expected.card
    const cheque = run.expected.cheque
    const totalTill = round2(cash + card + cheque)
    const c = Object.fromEntries(run.counts.map((x) => [x.tender, x.counted])) as Record<string, number>
    const counted = run.status === 'closed' ? round2((c.cash ?? 0) - run.openingFloat + (c.card ?? 0) + (c.cheque ?? 0)) : null
    return { run, cash, card, cheque, totalTill, counted, surplus: counted === null ? null : round2(counted - totalTill), directBank: run.expected.eft }
  })

  const sum = (f: (r: RunSummary) => number, only = runs) => round2(only.reduce((a, r) => a + f(r), 0))
  const paidAtTill = (r: RunSummary) => r.byTender.cash + r.byTender.card + r.byTender.cheque + r.byTender.eft
  const accountPaymentsAll = (r: RunSummary) => r.accountPayments.cash + r.accountPayments.card + r.accountPayments.cheque + r.accountPayments.eft

  const cashSales = sum(paidAtTill)
  const accountPayments = sum(accountPaymentsAll)
  const medAid = sum((r) => r.byTender.medical_aid)
  const pettyCash = sum((r) => r.pettyCash)
  const directBank = sum((r) => r.expected.eft)
  const payments = {
    cashSales, accountPayments, medAid,
    total: round2(cashSales + accountPayments + medAid),
    lessMedAid: medAid, lessPettyCash: pettyCash,
    subtotal: round2(cashSales + accountPayments - pettyCash),
    lessDirectBank: directBank,
    totalPayments: round2(cashSales + accountPayments - pettyCash - directBank),
  }

  // What went to the bank, from the counts of runs already cashed up.
  const closed = rows.filter((r) => r.run.status === 'closed')
  const countedOf = (r: CashAnalysisRow, t: string) => r.run.counts.find((c) => c.tender === t)?.counted ?? 0
  const creditCard = round2(closed.reduce((a, r) => a + countedOf(r, 'card'), 0))
  const depAmount = round2(closed.reduce((a, r) => a + countedOf(r, 'cash') - r.run.openingFloat + countedOf(r, 'cheque'), 0))
  const closedPayments = round2(closed.reduce((a, r) => a + r.totalTill, 0))
  const bank = {
    creditCard, depAmount, total: round2(creditCard + depAmount),
    surplus: round2(creditCard + depAmount - closedPayments),
    runsNotCounted: rows.length - closed.length,
  }

  const accountSales = sum((r) => r.byTender.account)
  const turnover = { cashSales, accountSales, medicalFund: medAid, total: round2(cashSales + accountSales + medAid) }

  const warnings: string[] = []
  for (const r of runs) {
    if (r.status === 'open') warnings.push(`Run ${r.runNo} (${r.tillCode}) is not cashed up yet.`)
    else if (r.sales.lastAt && r.sales.lastAt >= end) warnings.push(`Run ${r.runNo} (${r.tillCode}) has sales after the end of this range.`)
    if (r.late.count) warnings.push(`Run ${r.runNo} (${r.tillCode}) had ${r.late.count} sale(s) or entries reach the server after cash-up.`)
  }
  const [stray] = await tx`
    select count(*)::int as n from sales s join till_runs r on r.id = s.till_run_id
     where s.occurred_at >= ${start} and s.occurred_at < ${end} and (r.opened_at < ${start} or r.opened_at >= ${end})
       ${range.tillId ? tx`and r.till_id = ${range.tillId}` : tx``}`
  if (stray.n) warnings.push(`${stray.n} sale(s) in this range belong to runs opened outside it, so they are not in these totals.`)

  return { range, rows, payments, bank, turnover, warnings }
}

/** Sales, VAT, cost and GP per trading day, with the tender and assistant split for the range. */
export async function dailySales(tx: Tx, range: DayRange) {
  const { start, end, timezone } = await bounds(tx, range)
  const days = await tx`
    select (s.occurred_at at time zone ${timezone})::date::text as day,
           count(*) filter (where s.kind = 'sale')::int as sales, count(*) filter (where s.kind = 'refund')::int as refunds,
           sum(s.total) as total, sum(s.vat) as vat, sum(s.cost) as cost
      from sales s where s.occurred_at >= ${start} and s.occurred_at < ${end}
     group by 1 order by 1`
  const byTender = await tx`
    select p.tender, sum(p.amount) as amount from sale_payments p join sales s on s.id = p.sale_id
     where s.occurred_at >= ${start} and s.occurred_at < ${end} group by p.tender order by 2 desc`
  const byAssistant = await tx`
    select coalesce(u.name, 'Unknown') as name, count(*) filter (where s.kind = 'sale')::int as sales,
           sum(s.total) as total, sum(s.total - s.vat - s.cost) as gp
      from sales s left join users u on u.id = s.user_id
     where s.occurred_at >= ${start} and s.occurred_at < ${end} group by 1 order by 3 desc`
  const shape = (d: any) => {
    const total = num(d.total)
    const excl = round2(total - num(d.vat))
    const cost = round2(num(d.cost))
    const gp = round2(excl - cost)
    return { total, vat: num(d.vat), excl, cost, gp, gpPct: excl ? round2((gp / excl) * 100) : null }
  }
  const rows = days.map((d) => ({ day: d.day as string, sales: d.sales as number, refunds: d.refunds as number, ...shape(d) }))
  const totals = shape({
    total: rows.reduce((a, r) => a + r.total, 0), vat: rows.reduce((a, r) => a + r.vat, 0), cost: rows.reduce((a, r) => a + r.cost, 0),
  })
  return {
    range, rows,
    totals: { sales: rows.reduce((a, r) => a + r.sales, 0), refunds: rows.reduce((a, r) => a + r.refunds, 0), ...totals },
    byTender: byTender.map((t) => ({ tender: t.tender as string, amount: num(t.amount) })),
    byAssistant: byAssistant.map((a) => ({ name: a.name as string, sales: a.sales as number, total: num(a.total), gp: round2(num(a.gp)) })),
  }
}

/** GP per item over a range, on the price excl VAT and cost at the time of sale. */
export async function itemGp(tx: Tx, range: DayRange) {
  const { start, end } = await bounds(tx, range)
  const rows = await tx`
    select i.id, i.stock_code, i.description, i.pack_size, sum(l.qty_units)::int as units,
           sum(l.line_total) as total, sum(l.line_vat) as vat, sum(l.qty_units * coalesce(l.unit_cost, 0)) as cost,
           sum(l.list_total - l.line_total) as discount,
           bool_or(l.unit_cost is null) as missing_cost
      from sale_lines l join sales s on s.id = l.sale_id join items i on i.id = l.item_id
     where s.occurred_at >= ${start} and s.occurred_at < ${end}
     group by i.id order by sum(l.line_total - l.line_vat - l.qty_units * coalesce(l.unit_cost, 0)) desc`
  return rows.map((r) => {
    const excl = round2(num(r.total) - num(r.vat))
    const cost = round2(num(r.cost))
    const gp = round2(excl - cost)
    return {
      itemId: r.id as string, stockCode: r.stock_code as string, description: r.description as string, packSize: r.pack_size as number,
      units: r.units as number, total: num(r.total), excl, cost, gp, gpPct: excl ? round2((gp / excl) * 100) : null,
      discount: round2(num(r.discount)), missingCost: r.missing_cost as boolean,
    }
  })
}

/** Sales journal: every sale and refund in a range or a run. */
export async function listSales(tx: Tx, opts: { range?: DayRange; runId?: string; limit?: number }) {
  let where = tx`true`
  if (opts.runId) where = tx`s.till_run_id = ${opts.runId}`
  else if (opts.range) {
    const { start, end } = await bounds(tx, opts.range)
    where = tx`s.occurred_at >= ${start} and s.occurred_at < ${end}`
  }
  const rows = await tx`
    select s.id, s.sale_no, s.kind, s.occurred_at, s.total, s.vat, s.late, r.run_no, t.code as till_code, u.name as user_name,
           a.name as account_name, s.medical_aid,
           (select string_agg(p.tender, ', ' order by p.line_no) from sale_payments p where p.sale_id = s.id) as tenders,
           (select sum(l.list_total - l.line_total) from sale_lines l where l.sale_id = s.id) as discount
      from sales s join till_runs r on r.id = s.till_run_id join tills t on t.id = r.till_id
      left join users u on u.id = s.user_id left join customer_accounts a on a.id = s.account_id
     where ${where}
     order by s.occurred_at desc limit ${opts.limit ?? 500}`
  return rows.map((s) => ({
    id: s.id as string, saleNo: s.sale_no as number, kind: s.kind as string, occurredAt: s.occurred_at as Date, total: num(s.total),
    vat: num(s.vat), late: s.late as boolean, runNo: s.run_no as number, tillCode: s.till_code as string, userName: s.user_name as string | null,
    accountName: s.account_name as string | null, medicalAid: s.medical_aid as string | null, tenders: s.tenders as string,
    discount: round2(num(s.discount)),
  }))
}
