import type { Tx } from '../db/index.js'
import { num, numOrNull } from '../db/index.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'
import { round2 } from './pricing.js'
import { getSettings } from './settings.js'
import { postMovements } from './stock.js'

/**
 * The till: runs (drawer sessions), sales with split tenders, petty cash and account payments.
 * Everything here can arrive late from an offline till, so every write is keyed on an id the
 * till made, and recording the same id twice does nothing.
 */

export const tenders = ['cash', 'card', 'cheque', 'eft', 'account', 'medical_aid'] as const
export type Tender = (typeof tenders)[number]
export const tenderLabels: Record<Tender, string> = {
  cash: 'Cash', card: 'Card', cheque: 'Cheque', eft: 'EFT / direct bank', account: 'Account', medical_aid: 'Medical aid',
}
/** Tenders a till can take outside a sale (account payments). */
export const drawerTenders = ['cash', 'card', 'cheque', 'eft'] as const
export type DrawerTender = (typeof drawerTenders)[number]

/** Price of a line at the item's list price: units as a fraction of the pack price. Exact for whole packs. */
export function linePrice(retailPerPack: number, packSize: number, units: number): number {
  return round2((units / packSize) * retailPerPack)
}

/** Round a cash amount to the nearest step (Botswana has no coin below 5 thebe). Halves round away from zero. */
export function roundCash(amount: number, step: number): number {
  if (!(step > 0.01)) return round2(amount)
  return round2(Math.sign(amount) * Math.round(Math.abs(amount) / step + 1e-9) * step)
}

/** VAT contained in a VAT-inclusive amount. */
export function vatIn(amountIncl: number, rate: number): number {
  return round2((amountIncl * rate) / (1 + rate))
}

const cents = (n: number) => Math.round(n * 100)

async function nextNumber(tx: Tx, name: string): Promise<number> {
  const [r] = await tx`
    insert into tenant_counters (tenant_id, name, value) values (current_setting('app.tenant_id')::uuid, ${name}, 1)
    on conflict (tenant_id, name) do update set value = tenant_counters.value + 1
    returning value`
  return Number(r.value)
}

// ---------------------------------------------------------------- tills

export async function createTill(tx: Tx, input: { code: string; name: string }, userId?: string) {
  const code = input.code.trim().toUpperCase()
  if (!code || !input.name.trim()) throw new DomainError('a till needs a code and a name')
  const [row] = await tx`
    insert into tills (tenant_id, code, name) values (current_setting('app.tenant_id')::uuid, ${code}, ${input.name.trim()})
    on conflict (tenant_id, code) do nothing returning id`
  if (!row) throw new DomainError(`till ${code} already exists`, 'duplicate', 409)
  await audit(tx, userId, 'create', 'till', row.id, { code })
  return row.id as string
}

export async function listTills(tx: Tx) {
  const rows = await tx`
    select t.*, (select count(*) from till_runs r where r.till_id = t.id and r.status = 'open')::int as open_runs
      from tills t order by t.code`
  return rows.map((t) => ({
    id: t.id as string, code: t.code as string, name: t.name as string, active: t.active as boolean,
    lastSeenAt: t.last_seen_at as Date | null, lastPending: t.last_pending as number | null, openRuns: t.open_runs as number,
  }))
}

export async function touchTill(tx: Tx, tillId: string, pending: number | null) {
  await tx`update tills set last_seen_at = now(), last_pending = ${pending} where id = ${tillId}`
}

// ---------------------------------------------------------------- runs

export interface OpenRunInput {
  id: string
  tillId: string
  openingFloat: number
  openedAt: Date
}

/** Open a till run. The till makes the id, so a run can be opened while offline. */
export async function openRun(tx: Tx, input: OpenRunInput, userId?: string | null) {
  const [existing] = await tx`select run_no from till_runs where id = ${input.id}`
  if (existing) return { recorded: false, runNo: existing.run_no as number }
  if (!(input.openingFloat >= 0)) throw new DomainError('opening float cannot be negative')
  const [till] = await tx`select id, active from tills where id = ${input.tillId}`
  if (!till) throw new DomainError('unknown till', 'not_found', 404)
  const runNo = await nextNumber(tx, 'till_run')
  await tx`
    insert into till_runs (id, tenant_id, till_id, run_no, opening_float, opened_at, opened_by)
    values (${input.id}, current_setting('app.tenant_id')::uuid, ${input.tillId}, ${runNo}, ${round2(input.openingFloat)},
            ${input.openedAt}, ${userId ?? null})`
  return { recorded: true, runNo }
}

// ---------------------------------------------------------------- sales

export interface SaleLineInput {
  itemId: string
  qtyUnits: number            // negative on a refund
  listTotal: number           // at the price the till showed
  lineTotal: number           // what was charged, incl VAT
}

export interface PaymentInput {
  tender: Tender
  amount: number              // applied to the sale; cash net of change
  reference?: string | null
}

export interface SaleInput {
  id: string
  runId: string
  kind: 'sale' | 'refund'
  refundOf?: string | null
  occurredAt: Date
  accountId?: string | null
  medicalAid?: string | null
  memberNo?: string | null
  cashTendered?: number | null
  rounding?: number | null    // cash rounding taken on the sale: payments = lines + rounding
  lines: SaleLineInput[]
  payments: PaymentInput[]
}

/**
 * Record a sale or refund rung up on a till: the sale, its tenders, the stock movements and,
 * for an account tender, the charge on the customer's account. A sale that reaches the server
 * after its run was cashed up is still recorded (it happened) and marked late.
 */
export async function recordSale(tx: Tx, s: SaleInput, opts: { userId?: string | null; deviceId?: string | null } = {}) {
  const [dupe] = await tx`select sale_no from sales where id = ${s.id}`
  if (dupe) return { recorded: false, saleNo: dupe.sale_no as number }

  const sign = s.kind === 'refund' ? -1 : 1
  if (!s.lines.length) throw new DomainError('a sale needs at least one line')
  if (s.lines.length > 500) throw new DomainError('too many lines on one sale')
  for (const l of s.lines) {
    if (!Number.isInteger(l.qtyUnits) || l.qtyUnits === 0 || Math.sign(l.qtyUnits) !== sign) {
      throw new DomainError(s.kind === 'refund' ? 'refund quantities must be negative whole units' : 'sale quantities must be positive whole units')
    }
    if (!Number.isFinite(l.lineTotal) || l.lineTotal * sign < 0) throw new DomainError('line amounts must have the same sign as the sale')
  }
  const total = round2(s.lines.reduce((a, l) => a + round2(l.lineTotal), 0))
  const rounding = round2(s.rounding ?? 0)
  const paid = round2(s.payments.reduce((a, p) => a + round2(p.amount), 0))
  if (cents(paid) !== cents(total + rounding)) {
    throw new DomainError(`payments (P${paid.toFixed(2)}) don't add up to the sale (P${round2(total + rounding).toFixed(2)})`)
  }
  if (rounding !== 0) {
    const { cashRounding } = await getSettings(tx)
    if (!s.payments.some((p) => p.tender === 'cash')) throw new DomainError('only a cash payment can be rounded')
    if (cents(Math.abs(rounding)) * 2 > cents(cashRounding)) throw new DomainError(`cash rounding of P${rounding.toFixed(2)} is more than half of P${cashRounding.toFixed(2)}`)
  }
  for (const p of s.payments) {
    if (!tenders.includes(p.tender)) throw new DomainError(`unknown tender ${p.tender}`)
    if (!Number.isFinite(p.amount) || p.amount === 0 || Math.sign(p.amount) !== sign) throw new DomainError('payment amounts must have the same sign as the sale')
  }
  const usesAccount = s.payments.some((p) => p.tender === 'account')
  if (usesAccount && !s.accountId) throw new DomainError('an account tender needs the customer account')
  if (s.payments.some((p) => p.tender === 'medical_aid') && !s.medicalAid?.trim()) throw new DomainError('a medical aid tender needs the medical aid name')
  if (s.accountId) {
    const [acc] = await tx`select id from customer_accounts where id = ${s.accountId}`
    if (!acc) throw new DomainError('unknown customer account', 'not_found', 404)
  }
  const cashPaid = round2(s.payments.filter((p) => p.tender === 'cash').reduce((a, p) => a + p.amount, 0))
  let cashTendered: number | null = null
  let change: number | null = null
  if (s.kind === 'sale' && cashPaid > 0) {
    cashTendered = round2(s.cashTendered ?? cashPaid)
    if (cents(cashTendered) < cents(cashPaid)) throw new DomainError('cash tendered is less than the cash paid')
    change = round2(cashTendered - cashPaid)
  }

  const [run] = await tx`select id, status from till_runs where id = ${s.runId}`
  if (!run) throw new DomainError('unknown till run', 'not_found', 404)
  if (s.refundOf) {
    const [orig] = await tx`select id from sales where id = ${s.refundOf} and kind = 'sale'`
    if (!orig) throw new DomainError('the sale being refunded was not found', 'not_found', 404)
  }

  const settings = await getSettings(tx)
  const ids = [...new Set(s.lines.map((l) => l.itemId))]
  const items = await tx`select id, pack_size, vat_rate, avg_cost_per_pack, cost_per_pack from items where id = any(${ids}::uuid[])`
  const byId = new Map(items.map((i) => [i.id as string, i]))
  const lines = s.lines.map((l, n) => {
    const it = byId.get(l.itemId)
    if (!it) throw new DomainError(`unknown item ${l.itemId}`, 'not_found', 404)
    const rate = numOrNull(it.vat_rate) ?? settings.vatRate
    const packCost = numOrNull(it.avg_cost_per_pack) ?? numOrNull(it.cost_per_pack)
    const lineTotal = round2(l.lineTotal)
    return {
      lineNo: n + 1, itemId: l.itemId, qtyUnits: l.qtyUnits, listTotal: round2(l.listTotal), lineTotal, rate,
      vat: vatIn(lineTotal, rate), unitCost: packCost === null ? null : packCost / (it.pack_size as number),
    }
  })
  const vat = round2(lines.reduce((a, l) => a + l.vat, 0))
  const cost = lines.reduce((a, l) => a + l.qtyUnits * (l.unitCost ?? 0), 0)
  const saleNo = await nextNumber(tx, 'sale')
  const late = run.status === 'closed'

  await tx`
    insert into sales (id, tenant_id, sale_no, till_run_id, kind, refund_of, occurred_at, user_id, account_id, medical_aid, member_no,
                       total, rounding, vat, cost, cash_tendered, change_given, late)
    values (${s.id}, current_setting('app.tenant_id')::uuid, ${saleNo}, ${s.runId}, ${s.kind}, ${s.refundOf ?? null}, ${s.occurredAt},
            ${opts.userId ?? null}, ${s.accountId ?? null}, ${s.medicalAid?.trim() || null}, ${s.memberNo?.trim() || null},
            ${total}, ${rounding}, ${vat}, ${Math.round(cost * 10000) / 10000}, ${cashTendered}, ${change}, ${late})`
  for (const l of lines) {
    await tx`
      insert into sale_lines (tenant_id, sale_id, line_no, item_id, qty_units, list_total, line_total, vat_rate, line_vat, unit_cost)
      values (current_setting('app.tenant_id')::uuid, ${s.id}, ${l.lineNo}, ${l.itemId}, ${l.qtyUnits}, ${l.listTotal}, ${l.lineTotal},
              ${l.rate}, ${l.vat}, ${l.unitCost})`
  }
  for (const [n, p] of s.payments.entries()) {
    await tx`
      insert into sale_payments (tenant_id, sale_id, line_no, tender, amount, reference)
      values (current_setting('app.tenant_id')::uuid, ${s.id}, ${n + 1}, ${p.tender}, ${round2(p.amount)}, ${p.reference?.trim() || null})`
  }
  // The goods have already left (or come back over) the counter, so record them whatever the stock level says.
  await postMovements(tx, lines.map((l) => ({
    itemId: l.itemId, kind: s.kind === 'refund' ? 'sale_return' as const : 'sale' as const, qtyUnits: -l.qtyUnits,
    unitCost: l.unitCost, unitRetail: l.lineTotal / l.qtyUnits, refType: 'sale', refId: s.id,
    deviceId: opts.deviceId ?? null, occurredAt: s.occurredAt,
  })), { userId: opts.userId, happened: true })
  const onAccount = round2(s.payments.filter((p) => p.tender === 'account').reduce((a, p) => a + p.amount, 0))
  if (onAccount !== 0) {
    await tx`
      insert into account_entries (tenant_id, account_id, kind, amount, ref_type, ref_id, user_id, occurred_at)
      values (current_setting('app.tenant_id')::uuid, ${s.accountId!}, 'charge', ${onAccount}, 'sale', ${s.id}, ${opts.userId ?? null}, ${s.occurredAt})`
  }
  return { recorded: true, saleNo, late }
}

export async function getSale(tx: Tx, id: string) {
  const [s] = await tx`
    select s.*, r.run_no, t.code as till_code, u.name as user_name, a.name as account_name, a.account_no
      from sales s join till_runs r on r.id = s.till_run_id join tills t on t.id = r.till_id
      left join users u on u.id = s.user_id left join customer_accounts a on a.id = s.account_id
     where s.id = ${id}`
  if (!s) return null
  const lines = await tx`
    select l.*, i.stock_code, i.description, i.pack_size from sale_lines l join items i on i.id = l.item_id
     where l.sale_id = ${id} order by l.line_no`
  const payments = await tx`select * from sale_payments where sale_id = ${id} order by line_no`
  return {
    id: s.id as string, saleNo: s.sale_no as number, kind: s.kind as 'sale' | 'refund', refundOf: s.refund_of as string | null,
    runNo: s.run_no as number, tillCode: s.till_code as string, occurredAt: s.occurred_at as Date, userName: s.user_name as string | null,
    accountName: s.account_name as string | null, accountNo: s.account_no as string | null,
    medicalAid: s.medical_aid as string | null, memberNo: s.member_no as string | null,
    total: num(s.total), rounding: num(s.rounding), vat: num(s.vat), cost: num(s.cost), cashTendered: numOrNull(s.cash_tendered), change: numOrNull(s.change_given),
    late: s.late as boolean,
    lines: lines.map((l) => ({
      lineNo: l.line_no as number, itemId: l.item_id as string, stockCode: l.stock_code as string, description: l.description as string,
      packSize: l.pack_size as number, qtyUnits: l.qty_units as number, listTotal: num(l.list_total), lineTotal: num(l.line_total),
      vat: num(l.line_vat),
    })),
    payments: payments.map((p) => ({ tender: p.tender as Tender, amount: num(p.amount), reference: p.reference as string | null })),
  }
}

// ---------------------------------------------------------------- petty cash and account payments

export interface TillEntryInput {
  id: string
  runId: string
  kind: 'petty_cash' | 'account_payment'
  tender: DrawerTender
  amount: number
  accountId?: string | null
  note?: string | null
  occurredAt: Date
}

export async function recordTillEntry(tx: Tx, e: TillEntryInput, opts: { userId?: string | null } = {}) {
  const [dupe] = await tx`select id from till_entries where id = ${e.id}`
  if (dupe) return { recorded: false }
  if (!(e.amount > 0)) throw new DomainError('amount must be more than zero')
  if (!drawerTenders.includes(e.tender)) throw new DomainError(`unknown tender ${e.tender}`)
  if (e.kind === 'petty_cash') {
    if (e.tender !== 'cash') throw new DomainError('petty cash is paid out in cash')
    if (!e.note?.trim()) throw new DomainError('say what the petty cash was for')
  } else if (e.kind === 'account_payment') {
    if (!e.accountId) throw new DomainError('an account payment needs the customer account')
    const [acc] = await tx`select id from customer_accounts where id = ${e.accountId}`
    if (!acc) throw new DomainError('unknown customer account', 'not_found', 404)
  } else {
    throw new DomainError(`unknown till entry ${e.kind}`)
  }
  const [run] = await tx`select status from till_runs where id = ${e.runId}`
  if (!run) throw new DomainError('unknown till run', 'not_found', 404)
  const amount = round2(e.amount)
  await tx`
    insert into till_entries (id, tenant_id, till_run_id, kind, tender, amount, account_id, note, user_id, occurred_at, late)
    values (${e.id}, current_setting('app.tenant_id')::uuid, ${e.runId}, ${e.kind}, ${e.tender}, ${amount},
            ${e.accountId ?? null}, ${e.note?.trim() || null}, ${opts.userId ?? null}, ${e.occurredAt}, ${run.status === 'closed'})`
  if (e.kind === 'account_payment') {
    await tx`
      insert into account_entries (tenant_id, account_id, kind, amount, ref_type, ref_id, note, user_id, occurred_at)
      values (current_setting('app.tenant_id')::uuid, ${e.accountId!}, 'payment', ${-amount}, 'till_entry', ${e.id},
              ${e.note?.trim() || null}, ${opts.userId ?? null}, ${e.occurredAt})`
  }
  return { recorded: true }
}

// ---------------------------------------------------------------- cash-up

const zeroTenders = (): Record<Tender, number> => ({ cash: 0, card: 0, cheque: 0, eft: 0, account: 0, medical_aid: 0 })
const zeroDrawer = (): Record<DrawerTender, number> => ({ cash: 0, card: 0, cheque: 0, eft: 0 })

/** Tenders the shop counts at cash-up. EFT is checked against the bank statement instead. */
export const countedTenders = ['cash', 'card', 'cheque'] as const
export type CountedTender = (typeof countedTenders)[number]

export interface RunSummary {
  id: string
  runNo: number
  tillId: string
  tillCode: string
  tillName: string
  status: 'open' | 'closed'
  openedAt: Date
  openedBy: string | null
  closedAt: Date | null
  closedBy: string | null
  openingFloat: number
  floatKept: number | null
  note: string | null
  sales: { count: number; refunds: number; total: number; rounding: number; vat: number; cost: number; firstAt: Date | null; lastAt: Date | null }
  byTender: Record<Tender, number>          // sales less refunds, per tender
  accountPayments: Record<DrawerTender, number>
  pettyCash: number
  expected: Record<CountedTender | 'eft', number>
  counts: { tender: CountedTender; expected: number; counted: number; surplus: number }[]
  surplus: number | null                    // over all counted tenders, once cashed up
  late: { count: number; total: number }    // sales and entries that arrived after cash-up
  assistants: string[]
}

export async function runSummary(tx: Tx, runId: string): Promise<RunSummary | null> {
  const [r] = await tx`
    select r.*, t.code as till_code, t.name as till_name, ob.name as opened_by_name, cb.name as closed_by_name
      from till_runs r join tills t on t.id = r.till_id
      left join users ob on ob.id = r.opened_by left join users cb on cb.id = r.closed_by
     where r.id = ${runId}`
  if (!r) return null
  const [s] = await tx`
    select count(*) filter (where kind = 'sale')::int as sales, count(*) filter (where kind = 'refund')::int as refunds,
           coalesce(sum(total), 0) as total, coalesce(sum(rounding), 0) as rounding, coalesce(sum(vat), 0) as vat, coalesce(sum(cost), 0) as cost,
           min(occurred_at) as first_at, max(occurred_at) as last_at,
           count(*) filter (where late)::int as late_count, coalesce(sum(total) filter (where late), 0) as late_total
      from sales where till_run_id = ${runId}`
  const pays = await tx`
    select p.tender, sum(p.amount) as amount from sale_payments p join sales s on s.id = p.sale_id
     where s.till_run_id = ${runId} group by p.tender`
  const entries = await tx`
    select kind, tender, sum(amount) as amount, count(*) filter (where late)::int as late_count
      from till_entries where till_run_id = ${runId} group by kind, tender`
  const people = await tx`
    select distinct u.name from users u
     where u.id in (select user_id from sales where till_run_id = ${runId} union select user_id from till_entries where till_run_id = ${runId})
     order by u.name`
  const counts = await tx`select * from till_run_counts where till_run_id = ${runId}`

  const byTender = zeroTenders()
  for (const p of pays) byTender[p.tender as Tender] = round2(num(p.amount))
  const accountPayments = zeroDrawer()
  let pettyCash = 0
  let lateEntries = 0
  for (const e of entries) {
    if (e.kind === 'account_payment') accountPayments[e.tender as DrawerTender] = round2(num(e.amount))
    if (e.kind === 'petty_cash') pettyCash = round2(pettyCash + num(e.amount))
    lateEntries += e.late_count as number
  }
  const openingFloat = num(r.opening_float)
  const expected = {
    cash: round2(openingFloat + byTender.cash + accountPayments.cash - pettyCash),
    card: round2(byTender.card + accountPayments.card),
    cheque: round2(byTender.cheque + accountPayments.cheque),
    eft: round2(byTender.eft + accountPayments.eft),
  }
  const countRows = countedTenders
    .map((t) => counts.find((c) => c.tender === t))
    .filter(Boolean)
    .map((c) => ({ tender: c!.tender as CountedTender, expected: num(c!.expected), counted: num(c!.counted), surplus: round2(num(c!.counted) - num(c!.expected)) }))
  return {
    id: r.id, runNo: r.run_no, tillId: r.till_id, tillCode: r.till_code, tillName: r.till_name, status: r.status,
    openedAt: r.opened_at, openedBy: r.opened_by_name, closedAt: r.closed_at, closedBy: r.closed_by_name,
    openingFloat, floatKept: numOrNull(r.float_kept), note: r.note,
    sales: { count: s.sales, refunds: s.refunds, total: num(s.total), rounding: num(s.rounding), vat: num(s.vat), cost: num(s.cost), firstAt: s.first_at, lastAt: s.last_at },
    byTender, accountPayments, pettyCash, expected, counts: countRows,
    surplus: r.status === 'closed' ? round2(countRows.reduce((a, c) => a + c.surplus, 0)) : null,
    late: { count: (s.late_count as number) + lateEntries, total: num(s.late_total) },
    assistants: people.map((p) => p.name as string),
  }
}

export interface CashUpInput {
  counted: Record<CountedTender, number>
  floatKept: number
  note?: string | null
}

/** Cash up a run: store what was counted against what the system expected, and close it. */
export async function closeRun(tx: Tx, runId: string, input: CashUpInput, userId?: string) {
  const [r] = await tx`select status from till_runs where id = ${runId} for update`
  if (!r) throw new DomainError('unknown till run', 'not_found', 404)
  if (r.status !== 'open') throw new DomainError('this run is already cashed up', 'closed', 409)
  for (const t of countedTenders) {
    if (!Number.isFinite(input.counted[t]) || input.counted[t] < 0) throw new DomainError(`counted ${tenderLabels[t].toLowerCase()} must be zero or more`)
  }
  if (!(input.floatKept >= 0)) throw new DomainError('float kept cannot be negative')
  if (cents(input.floatKept) > cents(input.counted.cash)) throw new DomainError('the float kept back cannot be more than the cash counted')
  const sum = (await runSummary(tx, runId))!
  for (const t of countedTenders) {
    await tx`
      insert into till_run_counts (tenant_id, till_run_id, tender, expected, counted)
      values (current_setting('app.tenant_id')::uuid, ${runId}, ${t}, ${sum.expected[t]}, ${round2(input.counted[t])})`
  }
  await tx`
    update till_runs set status = 'closed', closed_at = now(), closed_by = ${userId ?? null},
           float_kept = ${round2(input.floatKept)}, note = ${input.note?.trim() || null}
     where id = ${runId}`
  await audit(tx, userId, 'cash_up', 'till_run', runId, { counted: input.counted, floatKept: input.floatKept })
  return (await runSummary(tx, runId))!
}

// ---------------------------------------------------------------- sync from a till

export type TillOp =
  | { type: 'open_run'; userId?: string | null; data: OpenRunInput }
  | { type: 'sale'; userId?: string | null; data: SaleInput }
  | { type: 'till_entry'; userId?: string | null; data: TillEntryInput }

export interface OpResult { id: string; status: 'recorded' | 'duplicate' | 'rejected'; error?: string; saleNo?: number; runNo?: number }

/** Is this a problem with the data sent (reject it) rather than with the server (let the till retry)? */
function isDataError(e: any) {
  return e instanceof DomainError || (typeof e?.code === 'string' && /^(22|23)/.test(e.code))
}

/**
 * Apply a till's queued operations in order. Each runs in its own savepoint so one bad
 * operation can't hold the rest back; it is kept in till_rejects for the back office.
 */
export async function applyTillOps(tx: Tx, tillId: string, ops: TillOp[], sessionUserId: string, deviceId?: string | null): Promise<OpResult[]> {
  const known = new Set((await tx`select id from users`).map((u) => u.id as string))
  const results: OpResult[] = []
  for (const op of ops) {
    const userId = op.userId && known.has(op.userId) ? op.userId : sessionUserId
    const id = op.data.id
    try {
      const res = await tx.savepoint(async (sp) => {
        if (op.type === 'open_run') {
          if (op.data.tillId !== tillId) throw new DomainError('run belongs to another till')
          const r = await openRun(sp, op.data, userId)
          return { id, status: r.recorded ? 'recorded' : 'duplicate', runNo: r.runNo } as OpResult
        }
        if (op.type === 'sale') {
          const r = await recordSale(sp, op.data, { userId, deviceId })
          return { id, status: r.recorded ? 'recorded' : 'duplicate', saleNo: r.saleNo } as OpResult
        }
        if (op.type === 'till_entry') {
          const r = await recordTillEntry(sp, op.data, { userId })
          return { id, status: r.recorded ? 'recorded' : 'duplicate' } as OpResult
        }
        throw new DomainError(`unknown operation ${(op as any).type}`)
      })
      results.push(res)
    } catch (e: any) {
      if (!isDataError(e)) throw e
      const [seen] = await tx`select 1 from till_rejects where op->'data'->>'id' = ${id} and not resolved`
      if (!seen) {
        await tx`insert into till_rejects (tenant_id, till_id, op, error) values (current_setting('app.tenant_id')::uuid, ${tillId}, ${tx.json(op as any)}, ${e.message})`
      }
      results.push({ id, status: 'rejected', error: e.message })
    }
  }
  return results
}
