import type { Tx } from '../db/index.js'
import { num, numOrNull } from '../db/index.js'
import { checkStaffPin, type ClientMeta } from './auth.js'
import { approvalNeeded, basketTotals, cashChange, countTotal, denominations, discountPct, linePrice, roundCash, vatIn, withinDiscount } from './basket.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'
import { round2 } from './pricing.js'
import { getSettings } from './settings.js'
import { postMovements } from './stock.js'
import { staffByCode } from './users.js'

export { linePrice, roundCash, vatIn }

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

const cents = (n: number) => Math.round(n * 100)

export async function nextNumber(tx: Tx, name: string): Promise<number> {
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

// ---------------------------------------------------------------- supervisor approvals

/** What a supervisor can allow at the till. */
export const approvalActions = ['discount', 'price_override', 'void', 'refund', 'petty_cash', 'no_sale', 'cash_drop'] as const
export type ApprovalAction = (typeof approvalActions)[number]

export interface ApprovalRequest {
  tillId: string
  subjectId: string            // the sale, till entry or event the till is about to record (its id is made by the till)
  action: ApprovalAction
  detail?: Record<string, unknown>
  staffCode: string            // the supervisor's 2-letter code
  pin: string                  // and their second PIN
  cashierCode?: string | null  // who asked
}

/**
 * A supervisor allows one thing on one sale or drawer entry by typing their staff code and second
 * PIN on the till. Needs the server: the PIN is never sent to the till, so it can't be checked offline.
 * Returns null (and counts the failure towards lockout) when the code or PIN is wrong.
 */
export async function grantApproval(tx: Tx, r: ApprovalRequest, meta: ClientMeta = {}) {
  if (!approvalActions.includes(r.action)) throw new DomainError(`unknown approval ${r.action}`)
  const [till] = await tx`select id from tills where id = ${r.tillId}`
  if (!till) throw new DomainError('unknown till', 'not_found', 404)
  const who = await checkStaffPin(tx, r.staffCode, r.pin, 'till.approve', meta)
  if (!who) return null
  const [row] = await tx`
    insert into till_approvals (tenant_id, till_id, subject_id, action, detail, approved_by, approver_code, cashier_code)
    values (current_setting('app.tenant_id')::uuid, ${r.tillId}, ${r.subjectId}, ${r.action}, ${tx.json((r.detail ?? {}) as any)},
            ${who.id}, ${who.code}, ${r.cashierCode?.trim().toUpperCase() || null})
    returning id`
  return { id: row.id as string, name: who.name, code: who.code }
}

interface Approval { id: string; action: ApprovalAction; detail: Record<string, any>; tillId: string }

/** Approvals given for one sale or entry on one till. */
async function approvalsFor(tx: Tx, subjectId: string, tillId: string): Promise<Approval[]> {
  const rows = await tx`select id, action, detail, till_id from till_approvals where subject_id = ${subjectId} and till_id = ${tillId}`
  return rows.map((a) => ({ id: a.id, action: a.action, detail: a.detail ?? {}, tillId: a.till_id }))
}

function findApproval(list: Approval[], id: string | null | undefined, action: ApprovalAction, what: string): Approval {
  const a = id ? list.find((x) => x.id === id && x.action === action) : undefined
  if (!a) throw new DomainError(`${what} needs a supervisor's approval, and none was found for this sale`)
  return a
}

// ---------------------------------------------------------------- runs

export interface OpenRunInput {
  id: string
  tillId: string
  openingFloat: number         // counted blind: the till never shows what the last run left
  openedAt: Date
  cashierCode?: string | null  // whose drawer it is
}

/** The run open on a till, if any (at most one; the database refuses a second). */
export async function openRunOnTill(tx: Tx, tillId: string) {
  const [r] = await tx`select id, run_no, opened_at, cashier_code from till_runs where till_id = ${tillId} and status = 'open' limit 1`
  return r ? { id: r.id as string, runNo: r.run_no as number, openedAt: r.opened_at as Date, cashierCode: r.cashier_code as string | null } : null
}

/**
 * Open a till run. The till makes the id, so a run can be opened while offline. A run belongs to
 * the till, the cashier who counted the float in, and its own id and number; a till can only have
 * one run open at a time.
 */
export async function openRun(tx: Tx, input: OpenRunInput, userId?: string | null) {
  const [existing] = await tx`select run_no from till_runs where id = ${input.id}`
  if (existing) return { recorded: false, runNo: existing.run_no as number }
  if (!Number.isFinite(input.openingFloat) || !(input.openingFloat >= 0)) throw new DomainError('opening float cannot be negative')
  const [till] = await tx`select id, active from tills where id = ${input.tillId} for update`
  if (!till) throw new DomainError('unknown till', 'not_found', 404)
  const open = await openRunOnTill(tx, input.tillId)
  if (open) throw new DomainError(`this till already has run ${open.runNo} open; cash it up before opening another`, 'run_open', 409)
  // The run is anchored to the cashier whose code opened it; a code the server no longer knows falls back to the till's login.
  const cashier = input.cashierCode ? await staffByCode(tx, input.cashierCode, 'till.use') : null
  const cashierId = cashier?.id ?? userId ?? null
  if (!cashierId) throw new DomainError('a run needs the cashier who opens it')
  const [last] = await tx`select float_kept from till_runs where till_id = ${input.tillId} and status = 'closed' order by closed_at desc limit 1`
  const runNo = await nextNumber(tx, 'till_run')
  await tx`
    insert into till_runs (id, tenant_id, till_id, run_no, opening_float, opened_at, opened_by, cashier_id, cashier_code, expected_float)
    values (${input.id}, current_setting('app.tenant_id')::uuid, ${input.tillId}, ${runNo}, ${round2(input.openingFloat)},
            ${input.openedAt}, ${userId ?? null}, ${cashierId}, ${cashier?.code ?? null}, ${last ? numOrNull(last.float_kept) : null})`
  return { recorded: true, runNo }
}

// ---------------------------------------------------------------- sales

export interface SaleLineInput {
  itemId: string
  qtyUnits: number            // negative on a refund
  listTotal: number           // at the price the till showed
  lineTotal: number           // what was charged, incl VAT
  scriptLineId?: string | null  // a line of a dispensed script: its stock left at dispensing
  adjust?: 'discount' | 'override' | null   // why lineTotal differs from listTotal
  approvalId?: string | null  // the supervisor's approval for a discount over the limit or a typed price
}

export interface PaymentInput {
  tender: Tender
  amount: number              // applied to the sale; cash net of change
  reference?: string | null   // card machine approval code, cheque or EFT reference
  gatewayToken?: string | null  // from a card terminal linked to the till
  gatewayPayload?: Record<string, unknown> | null
}

export interface SaleInput {
  id: string
  runId: string
  kind: 'sale' | 'refund'
  refundOf?: string | null
  refundApprovalId?: string | null
  occurredAt: Date
  accountId?: string | null
  medicalAid?: string | null
  memberNo?: string | null
  cashTendered?: number | null
  scriptId?: string | null     // paying for a dispensed script
  rounding?: number | null    // cash rounding taken on the sale: payments = lines + rounding
  cashierCode?: string | null // the 2-letter staff code the cashier typed for this sale
  lines: SaleLineInput[]
  payments: PaymentInput[]
}

const tokenShape = /^[A-Za-z0-9._:\-]{6,128}$/

/**
 * Record a sale or refund rung up on a till: the sale, its tenders, the stock movements and,
 * for an account tender, the charge on the customer's account. A sale that reaches the server
 * after its run was cashed up is still recorded (it happened) and marked late.
 *
 * The till's rules are checked again here, so a till that skipped them can't record a sale:
 * payments must settle the sale, change must be within the shop's limit, card payments need the
 * machine's approval code (or a gateway token), a price below the list needs a reason and, past the
 * cashier's limit, a supervisor's approval, and a refund needs the sale it reverses and a supervisor.
 */
export async function recordSale(tx: Tx, s: SaleInput, opts: { userId?: string | null; deviceId?: string | null } = {}) {
  const [dupe] = await tx`select sale_no from sales where id = ${s.id}`
  if (dupe) return { recorded: false, saleNo: dupe.sale_no as number }

  const settings = await getSettings(tx)
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
  // Zero-out rule: a sale with something to pay can't be finished with nothing paid.
  if (cents(total * sign) > 0 && cents(paid) === 0) throw new DomainError('nothing has been paid on this sale, so it cannot be finished')
  if (cents(paid) !== cents(total + rounding)) {
    throw new DomainError(`payments (P${paid.toFixed(2)}) don't add up to the sale (P${round2(total + rounding).toFixed(2)})`)
  }
  if (rounding !== 0) {
    if (!s.payments.some((p) => p.tender === 'cash')) throw new DomainError('only a cash payment can be rounded')
    if (cents(Math.abs(rounding)) * 2 > cents(settings.cashRounding)) throw new DomainError(`cash rounding of P${rounding.toFixed(2)} is more than half of P${settings.cashRounding.toFixed(2)}`)
  }
  for (const p of s.payments) {
    if (!tenders.includes(p.tender)) throw new DomainError(`unknown tender ${p.tender}`)
    if (!Number.isFinite(p.amount) || p.amount === 0 || Math.sign(p.amount) !== sign) throw new DomainError('payment amounts must have the same sign as the sale')
    if (p.tender === 'card') {
      // A card payment counts as paid only with proof from the card machine.
      if (settings.cardTerminal === 'integrated' && !tokenShape.test(p.gatewayToken ?? '')) throw new DomainError('a card payment needs the transaction token from the card terminal')
      if (settings.cardTerminal === 'standalone' && !p.reference?.trim() && !tokenShape.test(p.gatewayToken ?? '')) throw new DomainError('a card payment needs the approval code from the card machine slip')
    }
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
    const c = cashChange(cashTendered, cashPaid, settings.maxChange)
    if (c.tooMuch) throw new DomainError(`change of P${c.change.toFixed(2)} is more than the P${settings.maxChange.toFixed(2)} the till may give`)
    change = c.change
  }

  const [run] = await tx`select id, status, till_id from till_runs where id = ${s.runId}`
  if (!run) throw new DomainError('unknown till run', 'not_found', 404)
  const approvals = await approvalsFor(tx, s.id, run.till_id)

  // A refund is a separate record that points at the sale it reverses, and needs a supervisor.
  let refundOf = s.refundOf ?? null
  if (s.kind === 'refund') {
    if (!refundOf && s.scriptId) {
      const [paidFor] = await tx`select id from sales where script_id = ${s.scriptId} and kind = 'sale' order by occurred_at desc limit 1`
      refundOf = paidFor?.id ?? null
    }
    if (!refundOf) throw new DomainError('a refund must say which sale it reverses')
    const a = findApproval(approvals, s.refundApprovalId, 'refund', 'a refund')
    if (cents(Number(a.detail.total ?? 0)) < cents(Math.abs(total))) throw new DomainError(`the supervisor allowed a refund of P${Number(a.detail.total ?? 0).toFixed(2)}, less than this refund`)
  } else if (refundOf) {
    throw new DomainError('only a refund can point at another sale')
  }
  if (refundOf) await checkRefundFits(tx, refundOf, s.lines)

  const scriptLines = s.lines.filter((l) => l.scriptLineId)
  if (scriptLines.length && !s.scriptId) throw new DomainError('script lines need the script they belong to')
  if (s.scriptId) {
    const [script] = await tx`select id from scripts where id = ${s.scriptId} and status <> 'draft'`
    if (!script) throw new DomainError('the script being paid for was not found or is not dispensed', 'not_found', 404)
    const ids = scriptLines.map((l) => l.scriptLineId!)
    const found = await tx`select id, item_id from script_lines where script_id = ${s.scriptId} and id = any(${ids}::uuid[])`
    const itemOf = new Map(found.map((f) => [f.id as string, f.item_id as string]))
    for (const l of scriptLines) {
      if (itemOf.get(l.scriptLineId!) !== l.itemId) throw new DomainError('a script line does not belong to the script being paid for')
    }
  }

  const ids = [...new Set(s.lines.map((l) => l.itemId))]
  const items = await tx`select id, description, pack_size, vat_rate, avg_cost_per_pack, cost_per_pack, retail_per_pack from items where id = any(${ids}::uuid[])`
  const byId = new Map(items.map((i) => [i.id as string, i]))
  const mismatches: { lineNo: number; itemId: string; listTotal: number; priceNow: number }[] = []
  const lines = []
  for (const [n, l] of s.lines.entries()) {
    const it = byId.get(l.itemId)
    if (!it) throw new DomainError(`unknown item ${l.itemId}`, 'not_found', 404)
    const lineNo = n + 1
    const listTotal = round2(l.listTotal)
    const lineTotal = round2(l.lineTotal)
    const adjust = l.adjust ?? null
    const what = `line ${lineNo} (${it.description})`
    // Why the charged price differs from the list price, and who allowed it.
    if (cents(lineTotal) !== cents(listTotal) && !adjust) throw new DomainError(`${what} was charged a different price with no discount or price change recorded`)
    if (adjust === 'discount' && (Math.abs(lineTotal) > Math.abs(listTotal) || cents(lineTotal) === cents(listTotal))) throw new DomainError(`${what} is marked as discounted but is not cheaper than its list price`)
    let approvalId: string | null = null
    const needs = approvalNeeded({ listTotal, lineTotal, adjust }, settings.cashierDiscountPct)
    if (needs === 'discount') {
      const a = findApproval(approvals, l.approvalId, 'discount', `the ${discountPct(listTotal, lineTotal)}% discount on ${what}`)
      if (a.detail.itemId !== l.itemId || !withinDiscount(listTotal, lineTotal, Number(a.detail.pct ?? 0))) throw new DomainError(`the supervisor's approval does not cover the discount on ${what}`)
      approvalId = a.id
    } else if (needs === 'price_override') {
      const a = findApproval(approvals, l.approvalId, 'price_override', `the price typed in on ${what}`)
      const packPrice = Number(a.detail.packPrice)
      if (a.detail.itemId !== l.itemId || !Number.isFinite(packPrice) || cents(linePrice(packPrice, it.pack_size, l.qtyUnits)) !== cents(lineTotal)) {
        throw new DomainError(`the supervisor's approval does not cover the price on ${what}`)
      }
      approvalId = a.id
    } else if (l.approvalId) {
      approvalId = approvals.find((a) => a.id === l.approvalId)?.id ?? null
    }
    // The till's list price should be the item's price, or one it had in the last day (the till's price list can be a little old).
    if (s.kind === 'sale' && !l.scriptLineId) {
      const priceNow = linePrice(num(it.retail_per_pack), it.pack_size, l.qtyUnits)
      if (cents(priceNow) !== cents(listTotal)) {
        const recent = await tx`select retail_per_pack from price_history where item_id = ${l.itemId} and effective_from > ${s.occurredAt}::timestamptz - interval '1 day' and retail_per_pack is not null`
        if (!recent.some((r) => cents(linePrice(num(r.retail_per_pack), it.pack_size, l.qtyUnits)) === cents(listTotal))) {
          mismatches.push({ lineNo, itemId: l.itemId, listTotal, priceNow })
        }
      }
    }
    const rate = numOrNull(it.vat_rate) ?? settings.vatRate
    const packCost = numOrNull(it.avg_cost_per_pack) ?? numOrNull(it.cost_per_pack)
    lines.push({
      lineNo, itemId: l.itemId, qtyUnits: l.qtyUnits, listTotal, lineTotal, rate, scriptLineId: l.scriptLineId ?? null, adjust, approvalId,
      vat: vatIn(lineTotal, rate), unitCost: packCost === null ? null : packCost / (it.pack_size as number),
    })
  }
  const vat = basketTotals(lines.map((l) => ({ listTotal: l.listTotal, lineTotal: l.lineTotal, vatRate: l.rate }))).vat
  const cost = lines.reduce((a, l) => a + l.qtyUnits * (l.unitCost ?? 0), 0)
  const saleNo = await nextNumber(tx, 'sale')
  const late = run.status === 'closed'

  await tx`
    insert into sales (id, tenant_id, sale_no, till_run_id, kind, refund_of, refund_approval_id, occurred_at, user_id, account_id, medical_aid, member_no,
                       total, rounding, vat, cost, cash_tendered, change_given, late, script_id, cashier_code)
    values (${s.id}, current_setting('app.tenant_id')::uuid, ${saleNo}, ${s.runId}, ${s.kind}, ${refundOf}, ${s.kind === 'refund' ? s.refundApprovalId! : null},
            ${s.occurredAt}, ${opts.userId ?? null}, ${s.accountId ?? null}, ${s.medicalAid?.trim() || null}, ${s.memberNo?.trim() || null},
            ${total}, ${rounding}, ${vat}, ${Math.round(cost * 10000) / 10000}, ${cashTendered}, ${change}, ${late}, ${s.scriptId ?? null},
            ${s.cashierCode?.trim().toUpperCase() || null})`
  for (const l of lines) {
    await tx`
      insert into sale_lines (tenant_id, sale_id, line_no, item_id, qty_units, list_total, line_total, vat_rate, line_vat, unit_cost, script_line_id, adjust, approval_id)
      values (current_setting('app.tenant_id')::uuid, ${s.id}, ${l.lineNo}, ${l.itemId}, ${l.qtyUnits}, ${l.listTotal}, ${l.lineTotal},
              ${l.rate}, ${l.vat}, ${l.unitCost}, ${l.scriptLineId}, ${l.adjust}, ${l.approvalId})`
  }
  for (const [n, p] of s.payments.entries()) {
    await tx`
      insert into sale_payments (tenant_id, sale_id, line_no, tender, amount, reference, gateway_token, gateway_payload)
      values (current_setting('app.tenant_id')::uuid, ${s.id}, ${n + 1}, ${p.tender}, ${round2(p.amount)}, ${p.reference?.trim() || null},
              ${p.gatewayToken?.trim() || null}, ${p.gatewayPayload ? tx.json(p.gatewayPayload as any) : null})`
  }
  for (const m of mismatches) {
    await tx`
      insert into till_events (id, tenant_id, till_id, till_run_id, kind, priority, reason, detail, cashier_code, user_id, occurred_at)
      values (gen_random_uuid(), current_setting('app.tenant_id')::uuid, ${run.till_id}, ${s.runId}, 'price_mismatch', 'high',
              'the till charged a list price the item does not have', ${tx.json({ saleId: s.id, ...m } as any)},
              ${s.cashierCode?.trim().toUpperCase() || null}, ${opts.userId ?? null}, ${s.occurredAt})`
  }
  // The goods have already left (or come back over) the counter, so record them whatever the stock level says.
  // Script lines took their stock when the script was dispensed; a script's stock comes back only by reversing it.
  await postMovements(tx, lines.filter((l) => !l.scriptLineId).map((l) => ({
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

/** A refund can't give back more of an item, or more money for it, than the sale took (less earlier refunds). */
async function checkRefundFits(tx: Tx, saleId: string, lines: SaleLineInput[]) {
  const [orig] = await tx`select id from sales where id = ${saleId} and kind = 'sale'`
  if (!orig) throw new DomainError('the sale being refunded was not found', 'not_found', 404)
  const left = await refundableLines(tx, saleId)
  const want = new Map<string, { units: number; amount: number }>()
  for (const l of lines) {
    const w = want.get(l.itemId) ?? { units: 0, amount: 0 }
    w.units += -l.qtyUnits
    w.amount = round2(w.amount - l.lineTotal)
    want.set(l.itemId, w)
  }
  for (const [itemId, w] of want) {
    const has = left.get(itemId)
    if (!has || w.units > has.units) throw new DomainError(`the refund gives back more of an item than the sale it reverses still has (${has ? has.units : 0} units left)`)
    // Money back in proportion to the units coming back (to the cent), never more than is left.
    const fair = Math.min(round2((has.amount * w.units) / has.units), has.amount)
    if (cents(w.amount) > cents(fair) + 1) throw new DomainError(`the refund gives back more money for an item than was paid for it (P${fair.toFixed(2)} for ${w.units} unit(s))`)
  }
}

/** Per item: units and money of a sale not refunded yet. */
async function refundableLines(tx: Tx, saleId: string) {
  const rows = await tx`
    select l.item_id, sum(l.qty_units)::int as units, sum(l.line_total) as amount from sale_lines l where l.sale_id = ${saleId} group by l.item_id`
  const back = await tx`
    select l.item_id, sum(-l.qty_units)::int as units, sum(-l.line_total) as amount
      from sale_lines l join sales s on s.id = l.sale_id where s.refund_of = ${saleId} group by l.item_id`
  const out = new Map<string, { units: number; amount: number }>()
  for (const r of rows) out.set(r.item_id, { units: r.units, amount: num(r.amount) })
  for (const b of back) {
    const o = out.get(b.item_id)
    if (o) out.set(b.item_id, { units: o.units - b.units, amount: round2(o.amount - num(b.amount)) })
  }
  return out
}

/**
 * A sale found by its number or the reference printed on the slip (the first 8 characters of its id),
 * with what is left to refund on each line, so the till can ring up a refund that points at it.
 */
export async function saleForRefund(tx: Tx, ref: string) {
  const r = ref.trim().toLowerCase()
  const found = /^\d{1,9}$/.test(r) ? await tx`select id from sales where sale_no = ${Number(r)} and kind = 'sale'`
    : /^[0-9a-f]{8}$/.test(r) ? await tx`select id from sales where id::text like ${r + '%'} and kind = 'sale' limit 2`
    : []
  if (found.length !== 1) return null
  const s = found[0]
  const sale = (await getSale(tx, s.id))!
  const left = await refundableLines(tx, s.id)
  const [sc] = await tx`select script_id from sales where id = ${s.id}`
  return {
    id: sale.id, saleNo: sale.saleNo, ref: slipRef(sale.id), occurredAt: sale.occurredAt, total: sale.total, scriptId: sc.script_id as string | null,
    lines: sale.lines.map((l) => {
      const lft = left.get(l.itemId)
      // When an item is on several lines, what is left is shared; the server checks the total either way.
      return { itemId: l.itemId, stockCode: l.stockCode, description: l.description, packSize: l.packSize, qtyUnits: l.qtyUnits, lineTotal: l.lineTotal, vatRate: l.vatRate,
        unitsLeft: Math.max(0, Math.min(l.qtyUnits, lft?.units ?? 0)), amountLeft: Math.max(0, Math.min(l.lineTotal, lft?.amount ?? 0)) }
    }),
  }
}

/** The short reference printed on a slip: the first 8 characters of the sale's id. */
export const slipRef = (id: string) => id.slice(0, 8).toUpperCase()

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
    runNo: s.run_no as number, tillCode: s.till_code as string, occurredAt: s.occurred_at as Date, userName: s.cashier_code ? `${s.user_name ?? ''} (${s.cashier_code})`.trim() : (s.user_name as string | null),
    accountName: s.account_name as string | null, accountNo: s.account_no as string | null,
    medicalAid: s.medical_aid as string | null, memberNo: s.member_no as string | null,
    total: num(s.total), rounding: num(s.rounding), vat: num(s.vat), cost: num(s.cost), cashTendered: numOrNull(s.cash_tendered), change: numOrNull(s.change_given),
    late: s.late as boolean,
    lines: lines.map((l) => ({
      lineNo: l.line_no as number, itemId: l.item_id as string, stockCode: l.stock_code as string, description: l.description as string,
      packSize: l.pack_size as number, qtyUnits: l.qty_units as number, listTotal: num(l.list_total), lineTotal: num(l.line_total),
      vat: num(l.line_vat), vatRate: num(l.vat_rate), adjust: l.adjust as 'discount' | 'override' | null, approvalId: l.approval_id as string | null,
    })),
    payments: payments.map((p) => ({ tender: p.tender as Tender, amount: num(p.amount), reference: p.reference as string | null })),
  }
}

// ---------------------------------------------------------------- petty cash, account payments and cash drops

export interface TillEntryInput {
  id: string
  runId: string
  kind: 'petty_cash' | 'account_payment' | 'cash_drop'
  tender: DrawerTender
  amount: number
  accountId?: string | null
  note?: string | null
  approvalId?: string | null  // petty cash and cash drops: the supervisor who allowed it (for a drop, who took the cash)
  occurredAt: Date
}

export async function recordTillEntry(tx: Tx, e: TillEntryInput, opts: { userId?: string | null } = {}) {
  const [dupe] = await tx`select id from till_entries where id = ${e.id}`
  if (dupe) return { recorded: false }
  if (!Number.isFinite(e.amount) || !(e.amount > 0)) throw new DomainError('amount must be more than zero')
  if (!drawerTenders.includes(e.tender)) throw new DomainError(`unknown tender ${e.tender}`)
  const [run] = await tx`select status, till_id from till_runs where id = ${e.runId}`
  if (!run) throw new DomainError('unknown till run', 'not_found', 404)
  const amount = round2(e.amount)
  let approvalId: string | null = null
  if (e.kind === 'petty_cash' || e.kind === 'cash_drop') {
    if (e.tender !== 'cash') throw new DomainError(e.kind === 'petty_cash' ? 'petty cash is paid out in cash' : 'a cash drop is cash')
    if (e.kind === 'petty_cash' && !e.note?.trim()) throw new DomainError('say what the petty cash was for')
    const a = findApproval(await approvalsFor(tx, e.id, run.till_id), e.approvalId, e.kind, e.kind === 'petty_cash' ? 'petty cash' : 'a cash drop')
    if (cents(Number(a.detail.amount ?? 0)) < cents(amount)) throw new DomainError(`the supervisor allowed P${Number(a.detail.amount ?? 0).toFixed(2)}, less than this amount`)
    approvalId = a.id
  } else if (e.kind === 'account_payment') {
    if (!e.accountId) throw new DomainError('an account payment needs the customer account')
    const [acc] = await tx`select id from customer_accounts where id = ${e.accountId}`
    if (!acc) throw new DomainError('unknown customer account', 'not_found', 404)
  } else {
    throw new DomainError(`unknown till entry ${e.kind}`)
  }
  await tx`
    insert into till_entries (id, tenant_id, till_run_id, kind, tender, amount, account_id, note, user_id, occurred_at, late, approval_id)
    values (${e.id}, current_setting('app.tenant_id')::uuid, ${e.runId}, ${e.kind}, ${e.tender}, ${amount},
            ${e.accountId ?? null}, ${e.note?.trim() || null}, ${opts.userId ?? null}, ${e.occurredAt}, ${run.status === 'closed'}, ${approvalId})`
  if (e.kind === 'account_payment') {
    await tx`
      insert into account_entries (tenant_id, account_id, kind, amount, ref_type, ref_id, note, user_id, occurred_at)
      values (current_setting('app.tenant_id')::uuid, ${e.accountId!}, 'payment', ${-amount}, 'till_entry', ${e.id},
              ${e.note?.trim() || null}, ${opts.userId ?? null}, ${e.occurredAt})`
  }
  return { recorded: true }
}

// ---------------------------------------------------------------- drawer events: no-sales and voids

/** Reasons a cashier can give for opening the drawer with no sale. */
export const noSaleReasons = ['Change for a customer', 'Check the float', 'Correct a wrong change', 'Other'] as const

export interface TillEventInput {
  id: string
  runId: string
  kind: 'no_sale' | 'void'
  reason?: string | null
  detail?: Record<string, unknown>
  approvalId?: string | null
  cashierCode?: string | null
  occurredAt: Date
}

/**
 * Something done at the till that is not a sale but must leave a trace: opening the drawer with no
 * sale (a reason and a supervisor, logged as high priority), or a line taken off a sale before it
 * was paid (logged; high priority when it needed a supervisor).
 */
export async function recordTillEvent(tx: Tx, e: TillEventInput, opts: { userId?: string | null } = {}) {
  const [dupe] = await tx`select id from till_events where id = ${e.id}`
  if (dupe) return { recorded: false }
  const [run] = await tx`select till_id from till_runs where id = ${e.runId}`
  if (!run) throw new DomainError('unknown till run', 'not_found', 404)
  const approvals = await approvalsFor(tx, e.id, run.till_id)
  let approvalId: string | null = null
  let priority: 'normal' | 'high' = 'normal'
  if (e.kind === 'no_sale') {
    if (!e.reason?.trim()) throw new DomainError('a no-sale needs a reason')
    approvalId = findApproval(approvals, e.approvalId, 'no_sale', 'opening the drawer with no sale').id
    priority = 'high'
  } else if (e.kind === 'void') {
    if (e.approvalId) {
      // A void's approval was given for the sale the line was on.
      const saleId = String(e.detail?.saleId ?? '')
      const a = (await approvalsFor(tx, saleId, run.till_id)).find((x) => x.id === e.approvalId && x.action === 'void')
      if (!a) throw new DomainError('the void says a supervisor allowed it, but no such approval was found')
      approvalId = a.id
      priority = 'high'
    }
  } else {
    throw new DomainError(`unknown till event ${(e as any).kind}`)
  }
  const code = e.cashierCode?.trim().toUpperCase() || null
  await tx`
    insert into till_events (id, tenant_id, till_id, till_run_id, kind, priority, reason, detail, approval_id, cashier_code, user_id, occurred_at)
    values (${e.id}, current_setting('app.tenant_id')::uuid, ${run.till_id}, ${e.runId}, ${e.kind}, ${priority}, ${e.reason?.trim() || null},
            ${tx.json((e.detail ?? {}) as any)}, ${approvalId}, ${code}, ${opts.userId ?? null}, ${e.occurredAt})`
  if (e.kind === 'no_sale') {
    await audit(tx, opts.userId, 'till.no_sale', 'till_event', e.id, { priority: 'high', reason: e.reason, cashierCode: code, approvalId, runId: e.runId })
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
  cashier: string | null                    // whose drawer it is
  closedAt: Date | null
  closedBy: string | null
  openingFloat: number
  expectedFloat: number | null              // what the last run on this till left in the drawer
  floatKept: number | null
  note: string | null
  sales: { count: number; refunds: number; total: number; rounding: number; vat: number; cost: number; firstAt: Date | null; lastAt: Date | null }
  byTender: Record<Tender, number>          // sales less refunds, per tender
  accountPayments: Record<DrawerTender, number>
  pettyCash: number
  cashDrops: number
  netCash: number                           // cash in from sales and account payments, less petty cash
  expected: Record<CountedTender | 'eft', number>
  counts: { tender: CountedTender; expected: number; counted: number; surplus: number }[]
  cashCount: { denomination: number; qty: number }[]
  surplus: number | null                    // over all counted tenders, once cashed up
  late: { count: number; total: number }    // sales and entries that arrived after cash-up
  events: { noSales: number; voids: number; voidTotal: number; priceMismatches: number }
  zReport: { id: string; zNo: number } | null
  assistants: string[]
}

export async function runSummary(tx: Tx, runId: string): Promise<RunSummary | null> {
  const [r] = await tx`
    select r.*, t.code as till_code, t.name as till_name, ob.name as opened_by_name, cb.name as closed_by_name, cu.name as cashier_name
      from till_runs r join tills t on t.id = r.till_id
      left join users ob on ob.id = r.opened_by left join users cb on cb.id = r.closed_by left join users cu on cu.id = r.cashier_id
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
  const cashCount = await tx`select denomination, qty from till_run_cash_counts where till_run_id = ${runId} order by denomination desc`
  const [ev] = await tx`
    select count(*) filter (where kind = 'no_sale')::int as no_sales, count(*) filter (where kind = 'void')::int as voids,
           coalesce(sum((detail->>'lineTotal')::numeric) filter (where kind = 'void'), 0) as void_total,
           count(*) filter (where kind = 'price_mismatch')::int as mismatches
      from till_events where till_run_id = ${runId}`
  const [z] = await tx`select id, z_no from z_reports where till_run_id = ${runId}`

  const byTender = zeroTenders()
  for (const p of pays) byTender[p.tender as Tender] = round2(num(p.amount))
  const accountPayments = zeroDrawer()
  let pettyCash = 0
  let cashDrops = 0
  let lateEntries = 0
  for (const e of entries) {
    if (e.kind === 'account_payment') accountPayments[e.tender as DrawerTender] = round2(num(e.amount))
    if (e.kind === 'petty_cash') pettyCash = round2(pettyCash + num(e.amount))
    if (e.kind === 'cash_drop') cashDrops = round2(cashDrops + num(e.amount))
    lateEntries += e.late_count as number
  }
  const openingFloat = num(r.opening_float)
  const netCash = round2(byTender.cash + accountPayments.cash - pettyCash)
  // Expected cash = opening float + net cash transactions - cash drops (the variance is the count less this).
  const expected = {
    cash: round2(openingFloat + netCash - cashDrops),
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
    openedAt: r.opened_at, openedBy: r.opened_by_name, cashier: r.cashier_name ? `${r.cashier_name}${r.cashier_code ? ` (${r.cashier_code})` : ''}` : null,
    closedAt: r.closed_at, closedBy: r.closed_by_name,
    openingFloat, expectedFloat: numOrNull(r.expected_float), floatKept: numOrNull(r.float_kept), note: r.note,
    sales: { count: s.sales, refunds: s.refunds, total: num(s.total), rounding: num(s.rounding), vat: num(s.vat), cost: num(s.cost), firstAt: s.first_at, lastAt: s.last_at },
    byTender, accountPayments, pettyCash, cashDrops, netCash, expected, counts: countRows,
    cashCount: cashCount.map((c) => ({ denomination: num(c.denomination), qty: c.qty as number })),
    surplus: r.status === 'closed' ? round2(countRows.reduce((a, c) => a + c.surplus, 0)) : null,
    late: { count: (s.late_count as number) + lateEntries, total: num(s.late_total) },
    events: { noSales: ev.no_sales, voids: ev.voids, voidTotal: round2(num(ev.void_total)), priceMismatches: ev.mismatches },
    zReport: z ? { id: z.id as string, zNo: z.z_no as number } : null,
    assistants: people.map((p) => p.name as string),
  }
}

/** Is there more cash in this run's drawer than the shop wants there? Worked out on the server, without telling the till how much. */
export async function cashDropDue(tx: Tx, runId: string): Promise<boolean> {
  const s = await runSummary(tx, runId)
  if (!s || s.status !== 'open') return false
  const { cashDropThreshold } = await getSettings(tx)
  return cashDropThreshold > 0 && s.expected.cash > cashDropThreshold
}

export interface CashUpInput {
  /** Notes and coins counted, by denomination: { "200": 3, "0.5": 4 }. Gives the cash counted. */
  cash?: Record<string, number>
  counted: { cash?: number; card: number; cheque: number }
  floatKept: number
  note?: string | null
}

/**
 * Cash up a run: the person counting enters the notes and coins in the drawer, the card machine's
 * batch total and the cheques, without seeing what the system expects. The variance is worked out
 * and stored, a Z report is made, and the run is locked.
 */
export async function closeRun(tx: Tx, runId: string, input: CashUpInput, userId?: string) {
  const [r] = await tx`select status from till_runs where id = ${runId} for update`
  if (!r) throw new DomainError('unknown till run', 'not_found', 404)
  if (r.status !== 'open') throw new DomainError('this run is already cashed up', 'closed', 409)
  let cashCount: { denomination: number; qty: number }[] = []
  if (input.cash) {
    for (const [d, q] of Object.entries(input.cash)) {
      if (!denominations.includes(Number(d))) throw new DomainError(`P${d} is not a Botswana note or coin`)
      if (!Number.isInteger(q) || q < 0) throw new DomainError(`the number of P${d} must be a whole number, zero or more`)
      if (q > 0) cashCount.push({ denomination: Number(d), qty: q })
    }
    cashCount = cashCount.sort((a, b) => b.denomination - a.denomination)
  }
  const counted: Record<CountedTender, number> = {
    cash: input.cash ? countTotal(input.cash) : Number(input.counted.cash),
    card: input.counted.card, cheque: input.counted.cheque,
  }
  for (const t of countedTenders) {
    if (!Number.isFinite(counted[t]) || counted[t] < 0) throw new DomainError(`counted ${tenderLabels[t].toLowerCase()} must be zero or more`)
  }
  if (!Number.isFinite(input.floatKept) || !(input.floatKept >= 0)) throw new DomainError('float kept cannot be negative')
  if (cents(input.floatKept) > cents(counted.cash)) throw new DomainError('the float kept back cannot be more than the cash counted')
  const sum = (await runSummary(tx, runId))!
  for (const c of cashCount) {
    await tx`insert into till_run_cash_counts (tenant_id, till_run_id, denomination, qty) values (current_setting('app.tenant_id')::uuid, ${runId}, ${c.denomination}, ${c.qty})`
  }
  for (const t of countedTenders) {
    await tx`
      insert into till_run_counts (tenant_id, till_run_id, tender, expected, counted)
      values (current_setting('app.tenant_id')::uuid, ${runId}, ${t}, ${sum.expected[t]}, ${round2(counted[t])})`
  }
  await tx`
    update till_runs set status = 'closed', closed_at = now(), closed_by = ${userId ?? null},
           float_kept = ${round2(input.floatKept)}, note = ${input.note?.trim() || null}
     where id = ${runId}`
  const closed = (await runSummary(tx, runId))!
  const variance = round2(counted.cash - sum.expected.cash)
  await audit(tx, userId, 'cash_up', 'till_run', runId, { counted, cashCount, floatKept: input.floatKept, variance, expectedCash: sum.expected.cash })
  await makeZReport(tx, closed, userId)
  return (await runSummary(tx, runId))!
}

/**
 * The Z report: a fixed summary of a cashed-up run, numbered, never changed. It is queued for the
 * accounting system or a central server; until one is linked it waits in the outbox as 'no_target'.
 */
async function makeZReport(tx: Tx, s: RunSummary, userId?: string) {
  const vatRows = await tx`
    select l.vat_rate, sum(l.line_total) as gross, sum(l.line_vat) as vat
      from sale_lines l join sales x on x.id = l.sale_id where x.till_run_id = ${s.id} group by l.vat_rate order by l.vat_rate desc`
  const [adj] = await tx`
    select coalesce(sum(l.list_total - l.line_total) filter (where l.adjust = 'discount'), 0) as discounts,
           count(*) filter (where l.adjust = 'discount')::int as discount_lines,
           count(*) filter (where l.adjust = 'override')::int as override_lines,
           coalesce(sum(l.list_total - l.line_total) filter (where l.adjust = 'override'), 0) as override_diff
      from sale_lines l join sales x on x.id = l.sale_id where x.till_run_id = ${s.id} and x.kind = 'sale'`
  const [ref] = await tx`select coalesce(sum(-total), 0) as total from sales where till_run_id = ${s.id} and kind = 'refund'`
  const zNo = await nextNumber(tx, 'z_report')
  const cash = s.counts.find((c) => c.tender === 'cash')
  const payload = {
    zNo, till: { id: s.tillId, code: s.tillCode, name: s.tillName }, shift: { id: s.id, runNo: s.runNo, openedAt: s.openedAt, closedAt: s.closedAt },
    cashier: s.cashier, openedBy: s.openedBy, closedBy: s.closedBy,
    sales: { count: s.sales.count, refunds: s.sales.refunds, refundTotal: round2(num(ref.total)), net: s.sales.total, vat: s.sales.vat, rounding: s.sales.rounding },
    vatByRate: vatRows.map((v) => ({ rate: num(v.vat_rate), gross: round2(num(v.gross)), vat: round2(num(v.vat)), net: round2(num(v.gross) - num(v.vat)) })),
    tenders: s.byTender, accountPayments: s.accountPayments,
    discounts: { lines: adj.discount_lines, total: round2(num(adj.discounts)) }, priceOverrides: { lines: adj.override_lines, total: round2(num(adj.override_diff)) },
    voids: { count: s.events.voids, total: s.events.voidTotal }, noSales: s.events.noSales, priceMismatches: s.events.priceMismatches,
    cash: { openingFloat: s.openingFloat, netCash: s.netCash, pettyCash: s.pettyCash, cashDrops: s.cashDrops, expected: cash?.expected ?? s.expected.cash,
      counted: cash?.counted ?? null, variance: cash ? cash.surplus : null, floatKept: s.floatKept, notesAndCoins: s.cashCount },
    counts: s.counts, surplus: s.surplus, late: s.late,
  }
  const [z] = await tx`
    insert into z_reports (tenant_id, till_run_id, z_no, payload, created_by)
    values (current_setting('app.tenant_id')::uuid, ${s.id}, ${zNo}, ${tx.json(payload as any)}, ${userId ?? null}) returning id`
  await queueExport(tx, 'z_report', z.id, payload)
  return { id: z.id as string, zNo }
}

/**
 * Where finished Z reports go: an accounting package (QuickBooks, Sage) or a central server.
 * None is linked yet, so this records them as waiting with no target; linking one means adding a
 * sender here and marking the rows 'pending'.
 */
async function queueExport(tx: Tx, kind: 'z_report', refId: string, payload: unknown) {
  await tx`insert into export_outbox (tenant_id, kind, ref_id, payload, status) values (current_setting('app.tenant_id')::uuid, ${kind}, ${refId}, ${tx.json(payload as any)}, 'no_target')`
}

export async function getZReport(tx: Tx, runId: string) {
  const [z] = await tx`
    select z.*, o.status as export_status from z_reports z left join export_outbox o on o.ref_id = z.id and o.kind = 'z_report'
     where z.till_run_id = ${runId}`
  return z ? { id: z.id as string, zNo: z.z_no as number, createdAt: z.created_at as Date, payload: z.payload as any, exportStatus: z.export_status as string | null } : null
}

// ---------------------------------------------------------------- sync from a till

export type TillOp =
  | { type: 'open_run'; userId?: string | null; data: OpenRunInput }
  | { type: 'sale'; userId?: string | null; data: SaleInput }
  | { type: 'till_entry'; userId?: string | null; data: TillEntryInput }
  | { type: 'till_event'; userId?: string | null; data: TillEventInput }

export interface OpResult { id: string; status: 'recorded' | 'duplicate' | 'rejected'; error?: string; saleNo?: number; runNo?: number }

/** Is this a problem with the data sent (reject it) rather than with the server (let the till retry)? */
function isDataError(e: any) {
  return e instanceof DomainError || (typeof e?.code === 'string' && /^(22|23|P0001)/.test(e.code))
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
        const onThisTill = async (runId: string) => {
          const [r] = await sp`select till_id from till_runs where id = ${runId}`
          if (r && r.till_id !== tillId) throw new DomainError('run belongs to another till')
        }
        if (op.type === 'open_run') {
          if (op.data.tillId !== tillId) throw new DomainError('run belongs to another till')
          const r = await openRun(sp, op.data, userId)
          return { id, status: r.recorded ? 'recorded' : 'duplicate', runNo: r.runNo } as OpResult
        }
        if (op.type === 'sale') {
          // Every sale carries a cashier's staff code. A sale with none is refused (and kept under till problems).
          // The sale is credited to the person the code belongs to; a code that was valid on the till but is
          // unknown here (e.g. the login was since removed) still records the sale, under the till's login.
          if (!op.data.cashierCode?.trim()) throw new DomainError('this sale has no cashier code')
          await onThisTill(op.data.runId)
          const who = await staffByCode(sp, op.data.cashierCode, 'till.use')
          const r = await recordSale(sp, op.data, { userId: who?.id ?? userId, deviceId })
          return { id, status: r.recorded ? 'recorded' : 'duplicate', saleNo: r.saleNo } as OpResult
        }
        if (op.type === 'till_entry') {
          await onThisTill(op.data.runId)
          const r = await recordTillEntry(sp, op.data, { userId })
          return { id, status: r.recorded ? 'recorded' : 'duplicate' } as OpResult
        }
        if (op.type === 'till_event') {
          await onThisTill(op.data.runId)
          const r = await recordTillEvent(sp, op.data, { userId })
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
