import type { Tx } from '../db/index.js'
import { num, numOrNull } from '../db/index.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'
import { round2 } from './pricing.js'

/** Customer accounts (debtors): charged by account sales at the till, paid at the till or adjusted in the back office. */

export async function createAccount(tx: Tx, input: { accountNo: string; name: string; phone?: string | null; creditLimit?: number | null }, userId?: string) {
  const no = input.accountNo.trim().toUpperCase()
  if (!no || !input.name.trim()) throw new DomainError('an account needs a number and a name')
  if (input.creditLimit != null && !(input.creditLimit >= 0)) throw new DomainError('credit limit cannot be negative')
  const [row] = await tx`
    insert into customer_accounts (tenant_id, account_no, name, phone, credit_limit)
    values (current_setting('app.tenant_id')::uuid, ${no}, ${input.name.trim()}, ${input.phone?.trim() || null}, ${input.creditLimit ?? null})
    on conflict (tenant_id, account_no) do nothing returning id`
  if (!row) throw new DomainError(`account ${no} already exists`, 'duplicate', 409)
  await audit(tx, userId, 'create', 'customer_account', row.id, { accountNo: no })
  return row.id as string
}

export async function listAccounts(tx: Tx, opts: { activeOnly?: boolean } = {}) {
  const rows = await tx`
    select a.*, coalesce((select sum(e.amount) from account_entries e where e.account_id = a.id), 0) as balance,
           (select max(e.occurred_at) from account_entries e where e.account_id = a.id and e.kind = 'payment') as last_payment
      from customer_accounts a
     where ${opts.activeOnly ? tx`a.active` : tx`true`}
     order by a.name`
  return rows.map((a) => ({
    id: a.id as string, accountNo: a.account_no as string, name: a.name as string, phone: a.phone as string | null,
    creditLimit: numOrNull(a.credit_limit), active: a.active as boolean, balance: num(a.balance), lastPayment: a.last_payment as Date | null,
  }))
}

export async function accountStatement(tx: Tx, accountId: string) {
  const [a] = await tx`select * from customer_accounts where id = ${accountId}`
  if (!a) return null
  const entries = await tx`
    select e.*, s.sale_no, u.name as user_name,
           sum(e.amount) over (order by e.occurred_at, e.id) as balance
      from account_entries e left join sales s on e.ref_type = 'sale' and s.id = e.ref_id
      left join users u on u.id = e.user_id
     where e.account_id = ${accountId} order by e.occurred_at, e.id`
  return {
    id: a.id as string, accountNo: a.account_no as string, name: a.name as string, phone: a.phone as string | null,
    creditLimit: numOrNull(a.credit_limit), active: a.active as boolean,
    entries: entries.map((e) => ({
      kind: e.kind as string, amount: num(e.amount), balance: num(e.balance), occurredAt: e.occurred_at as Date,
      saleId: e.ref_type === 'sale' ? (e.ref_id as string) : null, saleNo: e.sale_no as number | null, note: e.note as string | null, userName: e.user_name as string | null,
    })),
    balance: entries.length ? num(entries[entries.length - 1].balance) : 0,
  }
}

/** A back-office correction or a payment taken outside the till (e.g. by bank transfer). */
export async function postAccountEntry(tx: Tx, accountId: string, input: { kind: 'payment' | 'adjustment'; amount: number; note: string }, userId?: string) {
  if (!input.note.trim()) throw new DomainError('add a note saying what this is')
  if (!Number.isFinite(input.amount) || input.amount === 0) throw new DomainError('amount must not be zero')
  if (input.kind === 'payment' && input.amount < 0) throw new DomainError('enter a payment as a positive amount')
  const amount = input.kind === 'payment' ? -round2(input.amount) : round2(input.amount)
  const [acc] = await tx`select id from customer_accounts where id = ${accountId}`
  if (!acc) throw new DomainError('unknown customer account', 'not_found', 404)
  await tx`
    insert into account_entries (tenant_id, account_id, kind, amount, note, user_id)
    values (current_setting('app.tenant_id')::uuid, ${accountId}, ${input.kind}, ${amount}, ${input.note.trim()}, ${userId ?? null})`
  await audit(tx, userId, input.kind, 'customer_account', accountId, { amount })
}

export interface AgeRow {
  id: string
  accountNo: string
  name: string
  balance: number
  current: number      // 0-30 days
  d30: number          // 31-60
  d60: number          // 61-90
  d90: number          // over 90
  creditLimit: number | null
}

/**
 * Age analysis: payments and credits clear the oldest charges first, and what is left
 * is bucketed by how long ago it was charged.
 */
export async function ageAnalysis(tx: Tx, asOf = new Date()): Promise<AgeRow[]> {
  const accounts = await tx`select id, account_no, name, credit_limit from customer_accounts order by name`
  const entries = await tx`select account_id, amount, occurred_at from account_entries where occurred_at <= ${asOf} order by occurred_at, id`
  const byAccount = new Map<string, { amount: number; at: Date }[]>()
  for (const e of entries) {
    const list = byAccount.get(e.account_id) ?? []
    list.push({ amount: num(e.amount), at: e.occurred_at })
    byAccount.set(e.account_id, list)
  }
  const out: AgeRow[] = []
  for (const a of accounts) {
    const list = byAccount.get(a.id) ?? []
    const charges = list.filter((e) => e.amount > 0).map((e) => ({ ...e }))
    let credit = -list.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0)
    for (const c of charges) {
      const used = Math.min(c.amount, credit)
      c.amount -= used
      credit -= used
    }
    const row: AgeRow = { id: a.id, accountNo: a.account_no, name: a.name, balance: 0, current: 0, d30: 0, d60: 0, d90: 0, creditLimit: numOrNull(a.credit_limit) }
    for (const c of charges) {
      if (c.amount <= 0) continue
      const days = (asOf.getTime() - c.at.getTime()) / 86_400_000
      if (days <= 30) row.current += c.amount
      else if (days <= 60) row.d30 += c.amount
      else if (days <= 90) row.d60 += c.amount
      else row.d90 += c.amount
    }
    row.current -= credit                       // money paid in advance shows as a credit in the current column
    for (const k of ['current', 'd30', 'd60', 'd90'] as const) row[k] = round2(row[k])
    row.balance = round2(row.current + row.d30 + row.d60 + row.d90)
    if (row.balance !== 0 || list.length) out.push(row)
  }
  return out
}
