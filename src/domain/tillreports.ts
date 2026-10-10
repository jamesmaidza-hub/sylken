import type { Tx } from '../db/index.js'
import { num, numOrNull } from '../db/index.js'
import { ageAnalysis } from './accounts.js'
import { priceFor } from './items.js'
import { patientName } from './patients.js'
import { round2 } from './pricing.js'
import { bounds, type DayRange } from './sales.js'
import { getSettings } from './settings.js'

/**
 * Till and back-office reports: customer accounts, the sales journal and its lines, assistants,
 * petty cash, prices changed at the till, markup, over-the-counter sales, contacts and the audit
 * log. Days are trading days in the shop's time zone, both ends included; money is incl VAT unless
 * a column says otherwise.
 */

const gpOf = (excl: number, cost: number) => ({ gp: round2(excl - cost), gpPct: excl ? round2(((excl - cost) / excl) * 100) : null })

// ---------------------------------------------------------------- accounts

export interface StatementLine { at: Date; what: string; saleId: string | null; charged: number; paid: number; balance: number; note: string | null; by: string | null }
export interface Statement {
  id: string; accountNo: string; name: string; phone: string | null; creditLimit: number | null
  opening: number; charged: number; paid: number; closing: number; lines: StatementLine[]
}

const entryWhat = (kind: string, amount: number, saleNo: number | null, refType: string | null) =>
  saleNo !== null ? `${amount < 0 ? 'Refund' : 'Sale'} ${saleNo}`
    : kind === 'payment' ? (refType === 'till_entry' ? 'Payment at the till' : 'Payment') : 'Adjustment'

/**
 * Statements for every account with something to say for the range: an opening balance, what was
 * charged and paid, and the closing balance. One account when accountId is given.
 */
export async function accountStatements(tx: Tx, range: DayRange, opts: { accountId?: string } = {}): Promise<Statement[]> {
  const b = await bounds(tx, range)
  const accounts = await tx`
    select a.id, a.account_no, a.name, a.phone, a.credit_limit,
           coalesce((select sum(e.amount) from account_entries e where e.account_id = a.id and e.occurred_at < ${b.start}), 0) as opening
      from customer_accounts a
     where ${opts.accountId ? tx`a.id = ${opts.accountId}` : tx`true`}
     order by a.name`
  const entries = await tx`
    select e.account_id, e.kind, e.amount, e.occurred_at, e.ref_type, e.ref_id, e.note, s.sale_no, u.name as by_name
      from account_entries e left join sales s on e.ref_type = 'sale' and s.id = e.ref_id left join users u on u.id = e.user_id
     where e.occurred_at >= ${b.start} and e.occurred_at < ${b.end}
       ${opts.accountId ? tx`and e.account_id = ${opts.accountId}` : tx``}
     order by e.occurred_at, e.id`
  const out: Statement[] = []
  for (const a of accounts) {
    const opening = num(a.opening)
    let bal = opening
    const lines: StatementLine[] = entries.filter((e) => e.account_id === a.id).map((e) => {
      const amount = num(e.amount)
      bal = round2(bal + amount)
      return {
        at: e.occurred_at, what: entryWhat(e.kind, amount, e.sale_no, e.ref_type), saleId: e.ref_type === 'sale' ? e.ref_id : null,
        charged: amount > 0 ? amount : 0, paid: amount < 0 ? -amount : 0, balance: bal, note: e.note, by: e.by_name,
      }
    })
    if (!lines.length && opening === 0 && !opts.accountId) continue
    out.push({
      id: a.id, accountNo: a.account_no, name: a.name, phone: a.phone, creditLimit: numOrNull(a.credit_limit), opening,
      charged: round2(lines.reduce((s, l) => s + l.charged, 0)), paid: round2(lines.reduce((s, l) => s + l.paid, 0)), closing: bal, lines,
    })
  }
  return out
}

/** Every account entry in the range: charges from the till, payments, and corrections made in the back office. */
export async function accountTransactions(tx: Tx, range: DayRange, opts: { kind?: string } = {}) {
  const b = await bounds(tx, range)
  const rows = await tx`
    select e.kind, e.amount, e.occurred_at, e.ref_type, e.ref_id, e.note, s.sale_no, a.id as account_id, a.account_no, a.name, u.name as by_name,
           t.code as till_code
      from account_entries e join customer_accounts a on a.id = e.account_id
      left join sales s on e.ref_type = 'sale' and s.id = e.ref_id
      left join till_entries te on e.ref_type = 'till_entry' and te.id = e.ref_id
      left join till_runs r on r.id = coalesce(s.till_run_id, te.till_run_id) left join tills t on t.id = r.till_id
      left join users u on u.id = e.user_id
     where e.occurred_at >= ${b.start} and e.occurred_at < ${b.end}
       ${opts.kind ? tx`and e.kind = ${opts.kind}` : tx``}
     order by e.occurred_at, e.id`
  return rows.map((e) => {
    const amount = num(e.amount)
    return {
      at: e.occurred_at as Date, accountId: e.account_id as string, accountNo: e.account_no as string, name: e.name as string, kind: e.kind as string,
      what: entryWhat(e.kind, amount, e.sale_no, e.ref_type), saleId: e.ref_type === 'sale' ? (e.ref_id as string) : null,
      where: e.till_code ? `Till ${e.till_code}` : 'Back office', charged: amount > 0 ? amount : 0, paid: amount < 0 ? -amount : 0,
      note: e.note as string | null, by: e.by_name as string | null,
    }
  })
}

/** Debtors as at the end of a day: age analysis with phone, limit and the last payment. */
export async function debtors(tx: Tx, asOf: string) {
  const b = await bounds(tx, { from: asOf, to: asOf })
  const aged = await ageAnalysis(tx, new Date(b.end.getTime() - 1))
  const extra = await tx`
    select a.id, a.phone,
           (select max(e.occurred_at) from account_entries e where e.account_id = a.id and e.kind = 'payment' and e.occurred_at < ${b.end}) as last_payment,
           (select max(e.occurred_at) from account_entries e where e.account_id = a.id and e.kind = 'charge' and e.occurred_at < ${b.end}) as last_charge
      from customer_accounts a`
  const byId = new Map(extra.map((x) => [x.id as string, x]))
  return aged.map((r) => {
    const x = byId.get(r.id)
    return { ...r, phone: (x?.phone ?? null) as string | null, lastPayment: (x?.last_payment ?? null) as Date | null, lastCharge: (x?.last_charge ?? null) as Date | null,
      overLimit: r.creditLimit !== null && r.balance > r.creditLimit }
  })
}

// ---------------------------------------------------------------- sales

/** Every sale and refund in the range, with how it was paid. */
export async function salesJournal(tx: Tx, range: DayRange, opts: { userId?: string } = {}) {
  const b = await bounds(tx, range)
  const rows = await tx`
    select s.id, s.sale_no, s.kind, s.occurred_at, s.total, s.vat, s.cost, s.rounding, s.late, r.run_no, t.code as till_code, u.name as user_name,
           a.account_no, a.name as account_name, s.medical_aid, s.member_no, sc.script_no,
           (select string_agg(case p.tender when 'medical_aid' then 'medical aid' else p.tender end || ' ' || to_char(p.amount, 'FM999999990.00'), ', ' order by p.line_no)
              from sale_payments p where p.sale_id = s.id) as tenders,
           (select coalesce(sum(l.list_total - l.line_total), 0) from sale_lines l where l.sale_id = s.id) as discount,
           (select count(*) from sale_lines l where l.sale_id = s.id) as lines
      from sales s join till_runs r on r.id = s.till_run_id join tills t on t.id = r.till_id
      left join users u on u.id = s.user_id left join customer_accounts a on a.id = s.account_id left join scripts sc on sc.id = s.script_id
     where s.occurred_at >= ${b.start} and s.occurred_at < ${b.end}
       ${opts.userId ? tx`and s.user_id = ${opts.userId}` : tx``}
     order by s.occurred_at, s.sale_no`
  return rows.map((s) => {
    const total = num(s.total), excl = round2(total - num(s.vat)), cost = round2(num(s.cost))
    return {
      id: s.id as string, saleNo: s.sale_no as number, kind: s.kind as string, at: s.occurred_at as Date, till: `${s.till_code} run ${s.run_no}`,
      assistant: s.user_name as string | null, account: s.account_no ? `${s.account_no} ${s.account_name}` : null,
      medicalAid: s.medical_aid ? `${s.medical_aid}${s.member_no ? ' ' + s.member_no : ''}` : null, scriptNo: s.script_no as number | null,
      lines: Number(s.lines), tenders: (s.tenders as string | null) ?? '', discount: round2(num(s.discount)), total, vat: num(s.vat), rounding: num(s.rounding),
      excl, cost, ...gpOf(excl, cost), late: s.late as boolean,
    }
  })
}

/** Every line rung up in the range: what was sold, at what price, and at what cost. */
export async function salesDetail(tx: Tx, range: DayRange, opts: { q?: string } = {}) {
  const b = await bounds(tx, range)
  const rows = await tx`
    select s.id as sale_id, s.sale_no, s.kind, s.occurred_at, u.name as user_name, sc.script_no,
           i.id as item_id, i.stock_code, i.description, i.pack_size, l.qty_units, l.list_total, l.line_total, l.line_vat,
           l.qty_units * coalesce(l.unit_cost, 0) as cost
      from sale_lines l join sales s on s.id = l.sale_id join items i on i.id = l.item_id
      left join users u on u.id = s.user_id left join scripts sc on sc.id = s.script_id
     where s.occurred_at >= ${b.start} and s.occurred_at < ${b.end}
       ${opts.q ? tx`and (upper(i.description) like ${'%' + opts.q.toUpperCase() + '%'} or upper(i.stock_code) = ${opts.q.toUpperCase()})` : tx``}
     order by s.occurred_at, s.sale_no, l.line_no`
  return rows.map((l) => {
    const total = num(l.line_total), excl = round2(total - num(l.line_vat)), cost = round2(num(l.cost))
    return {
      saleId: l.sale_id as string, saleNo: l.sale_no as number, kind: l.kind as string, at: l.occurred_at as Date, assistant: l.user_name as string | null,
      scriptNo: l.script_no as number | null, itemId: l.item_id as string, stockCode: l.stock_code as string, description: l.description as string,
      packSize: l.pack_size as number, units: l.qty_units as number, list: num(l.list_total), total, discount: round2(num(l.list_total) - total),
      vat: num(l.line_vat), excl, cost, ...gpOf(excl, cost),
    }
  })
}

/** Takings, refunds, discounts and GP per assistant, with account payments and petty cash they handled. */
export async function assistantSales(tx: Tx, range: DayRange) {
  const b = await bounds(tx, range)
  const rows = await tx`
    with s as (
      select s.user_id, s.kind, s.total, s.vat, s.cost,
             (select coalesce(sum(l.list_total - l.line_total), 0) from sale_lines l where l.sale_id = s.id) as discount,
             (select coalesce(sum(abs(l.qty_units)), 0) from sale_lines l where l.sale_id = s.id) as units
        from sales s where s.occurred_at >= ${b.start} and s.occurred_at < ${b.end}
    ), e as (
      select te.user_id, sum(te.amount) filter (where te.kind = 'account_payment') as acc, sum(te.amount) filter (where te.kind = 'petty_cash') as petty
        from till_entries te where te.occurred_at >= ${b.start} and te.occurred_at < ${b.end} group by te.user_id
    ), ids as (select user_id from s union select user_id from e)
    select ids.user_id, coalesce(u.name, 'Unknown') as name,
           (select count(*) from s where s.user_id is not distinct from ids.user_id and s.kind = 'sale') as sales,
           (select count(*) from s where s.user_id is not distinct from ids.user_id and s.kind = 'refund') as refunds,
           (select coalesce(sum(-s.total), 0) from s where s.user_id is not distinct from ids.user_id and s.kind = 'refund') as refunded,
           (select coalesce(sum(s.total), 0) from s where s.user_id is not distinct from ids.user_id) as total,
           (select coalesce(sum(s.vat), 0) from s where s.user_id is not distinct from ids.user_id) as vat,
           (select coalesce(sum(s.cost), 0) from s where s.user_id is not distinct from ids.user_id) as cost,
           (select coalesce(sum(s.discount), 0) from s where s.user_id is not distinct from ids.user_id) as discount,
           (select coalesce(sum(s.units), 0) from s where s.user_id is not distinct from ids.user_id and s.kind = 'sale') as units,
           coalesce(e.acc, 0) as acc, coalesce(e.petty, 0) as petty
      from ids left join users u on u.id = ids.user_id left join e on e.user_id is not distinct from ids.user_id
     order by 6 desc`
  return rows.map((r) => {
    const total = num(r.total), excl = round2(total - num(r.vat)), cost = round2(num(r.cost)), sales = Number(r.sales)
    return {
      name: r.name as string, sales, refunds: Number(r.refunds), refunded: num(r.refunded), units: Number(r.units), total, excl, cost, ...gpOf(excl, cost),
      discount: round2(num(r.discount)), perSale: sales ? round2((total + num(r.refunded)) / sales) : 0,
      accountPayments: num(r.acc), pettyCash: num(r.petty),
    }
  })
}

/** Petty cash paid out of the drawers in the range. */
export async function pettyCash(tx: Tx, range: DayRange) {
  const b = await bounds(tx, range)
  const rows = await tx`
    select te.occurred_at, te.amount, te.tender, te.note, te.late, r.run_no, t.code as till_code, u.name as by_name
      from till_entries te join till_runs r on r.id = te.till_run_id join tills t on t.id = r.till_id left join users u on u.id = te.user_id
     where te.kind = 'petty_cash' and te.occurred_at >= ${b.start} and te.occurred_at < ${b.end}
     order by te.occurred_at`
  return rows.map((r) => ({
    at: r.occurred_at as Date, till: `${r.till_code} run ${r.run_no}`, amount: num(r.amount), tender: r.tender as string,
    note: r.note as string | null, by: r.by_name as string | null, late: r.late as boolean,
  }))
}

/** Lines rung up at a different price from the item's price at the time: discounts and price overrides. */
export async function tillPriceAlterations(tx: Tx, range: DayRange) {
  const rows = (await salesDetail(tx, range)).filter((l) => l.discount !== 0)
  return rows.map((l) => ({ ...l, changePct: l.list ? round2(((l.total - l.list) / l.list) * 100) : null }))
}

/** Over-the-counter sales per item: everything rung up at the till that was not paying for a script. */
export async function otcSales(tx: Tx, range: DayRange) {
  const b = await bounds(tx, range)
  const rows = await tx`
    select i.id, i.stock_code, i.description, i.pack_size, i.schedule, sum(l.qty_units)::int as units, count(distinct s.id) as sales,
           sum(l.line_total) as total, sum(l.line_vat) as vat, sum(l.qty_units * coalesce(l.unit_cost, 0)) as cost, sum(l.list_total - l.line_total) as discount
      from sale_lines l join sales s on s.id = l.sale_id join items i on i.id = l.item_id
     where s.occurred_at >= ${b.start} and s.occurred_at < ${b.end} and s.script_id is null and l.script_line_id is null
     group by i.id order by sum(l.line_total) desc, i.description`
  return rows.map((r) => {
    const total = num(r.total), excl = round2(total - num(r.vat)), cost = round2(num(r.cost))
    return {
      itemId: r.id as string, stockCode: r.stock_code as string, description: r.description as string, packSize: r.pack_size as number,
      schedule: r.schedule as number | null, units: r.units as number, sales: Number(r.sales), total, excl, cost, ...gpOf(excl, cost), discount: round2(num(r.discount)),
    }
  })
}

// ---------------------------------------------------------------- items, contacts, audit

/** Each active item's markup and GP, and whether its price is still what the markup rule gives. */
export async function markupReport(tx: Tx, opts: { below?: number; above?: number; offRule?: boolean; q?: string } = {}) {
  const s = await getSettings(tx)
  const rows = await tx`
    select i.id, i.stock_code, i.description, i.pack_size, i.cost_per_pack, i.retail_per_pack, i.vat_rate, i.markup_override
      from items i
     where i.status = 'active' and i.cost_per_pack > 0
       ${opts.q ? tx`and (upper(i.description) like ${'%' + opts.q.toUpperCase() + '%'} or upper(i.stock_code) = ${opts.q.toUpperCase()})` : tx``}
     order by i.description`
  const out = rows.map((r) => {
    const cost = num(r.cost_per_pack), retail = num(r.retail_per_pack), vat = numOrNull(r.vat_rate) ?? s.vatRate
    const excl = retail / (1 + vat)
    const setMarkup = numOrNull(r.markup_override) ?? s.defaultMarkup
    const rulePrice = priceFor(s, cost, numOrNull(r.markup_override), numOrNull(r.vat_rate))
    return {
      itemId: r.id as string, stockCode: r.stock_code as string, description: r.description as string, cost, retail,
      markupExcl: round2((excl / cost - 1) * 100), markupIncl: round2((retail / cost - 1) * 100), gpPct: excl ? round2(((excl - cost) / excl) * 100) : null,
      setMarkup: round2(setMarkup * 100), own: r.markup_override !== null, rulePrice, difference: round2(retail - rulePrice),
    }
  })
  return out.filter((x) =>
    (opts.below === undefined || x.markupExcl < opts.below) && (opts.above === undefined || x.markupExcl > opts.above) && (!opts.offRule || x.difference !== 0))
    .sort((a, b) => a.markupExcl - b.markupExcl)
}

/** Phone numbers for customer accounts and patients, in one list. */
export async function contacts(tx: Tx, opts: { kind?: 'account' | 'patient'; withPhone?: boolean; q?: string } = {}) {
  const q = opts.q ? '%' + opts.q.toUpperCase() + '%' : null
  const accounts = opts.kind === 'patient' ? [] : await tx`
    select a.id, a.account_no, a.name, a.phone, a.active, coalesce((select sum(e.amount) from account_entries e where e.account_id = a.id), 0) as balance
      from customer_accounts a where ${q ? tx`upper(a.name) like ${q}` : tx`true`}`
  const patients = opts.kind === 'account' ? [] : await tx`
    select p.id, p.title, p.first_names, p.surname, p.main_member_id, p.dependant_code, mm.surname as mm_surname, mm.first_names as mm_first_names,
           coalesce(p.phone, mm.phone) as phone, p.address, p.active, ma.name as aid_name,
           coalesce(mm.member_no, p.member_no) as member_no,
           (select max(s.dispensed_at) from scripts s where s.patient_id = p.id and s.status = 'dispensed') as last_visit
      from patients p left join patients mm on mm.id = p.main_member_id
      left join medical_aids ma on ma.id = coalesce(mm.medical_aid_id, p.medical_aid_id)
     where ${q ? tx`(upper(p.surname) like ${q} or upper(coalesce(p.first_names, '')) like ${q})` : tx`true`}`
  const out = [
    ...accounts.map((a) => ({ kind: 'Account', id: a.id as string, href: `/accounts/${a.id}`, name: a.name as string, ref: a.account_no as string,
      phone: a.phone as string | null, address: null as string | null, detail: `Owes P${num(a.balance).toFixed(2)}`, active: a.active as boolean, last: null as Date | null,
      sort: [String(a.name).toUpperCase()] as (string | number)[] })),
    ...patients.map((p) => ({ kind: 'Patient', id: p.id as string, href: `/dispensary/patients/${p.id}`, name: patientName(p as any),
      ref: p.member_no as string | null, phone: p.phone as string | null, address: p.address as string | null,
      detail: (p.aid_name as string | null) ?? 'Private', active: p.active as boolean, last: p.last_visit as Date | null,
      // Families stay together, main member (00) first.
      sort: [String(p.mm_surname ?? p.surname).toUpperCase(), String(p.mm_first_names ?? p.first_names ?? '').toUpperCase(),
        String(p.main_member_id ?? p.id), p.main_member_id ? 1 : 0, String(p.dependant_code ?? ''), String(p.first_names ?? '').toUpperCase()] })),
  ]
  const cmp = (a: (string | number)[], b: (string | number)[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? '', y = b[i] ?? ''
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      if (c) return c
    }
    return 0
  }
  return out.filter((x) => x.active && (!opts.withPhone || x.phone)).sort((a, b) => cmp(a.sort, b.sort)).map(({ sort: _, ...x }) => x)
}

export const auditLabels: Record<string, string> = {
  item: 'Item', patient: 'Patient', script: 'Script', customer_account: 'Account', doctor: 'Doctor', medical_aid: 'Medical aid',
  till: 'Till', till_run: 'Till run', stock_take: 'Stock take', supplier_invoice: 'Invoice', direction: 'Direction', minmax_suggestions: 'Min/max',
  owed_item: 'Owed item',
}

const auditHref: Record<string, string> = {
  item: '/items/', patient: '/dispensary/patients/', script: '/dispensary/scripts/', customer_account: '/accounts/', doctor: '/dispensary/doctors/',
  till_run: '/cashup/runs/', stock_take: '/stocktakes/', supplier_invoice: '/receiving/',
}

/** Who did what in the back office, newest first. */
export async function auditLog(tx: Tx, range: DayRange, opts: { userId?: string; entity?: string } = {}) {
  const b = await bounds(tx, range)
  const rows = await tx`
    select l.at, l.action, l.entity, l.entity_id, l.detail, u.name as by_name
      from audit_log l left join users u on u.id = l.user_id
     where l.at >= ${b.start} and l.at < ${b.end}
       ${opts.userId ? tx`and l.user_id = ${opts.userId}` : tx``}
       ${opts.entity ? tx`and l.entity = ${opts.entity}` : tx``}
     order by l.at desc, l.id desc limit 5000`
  return rows.map((r) => ({
    at: r.at as Date, by: r.by_name as string | null, action: (r.action as string).replace(/_/g, ' '), entity: auditLabels[r.entity] ?? r.entity,
    entityId: r.entity_id as string | null, href: r.entity_id && auditHref[r.entity] ? auditHref[r.entity] + r.entity_id : undefined,
    detail: r.detail === null ? '' : JSON.stringify(r.detail).slice(0, 300),
  }))
}
