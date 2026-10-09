import { Hono } from 'hono'
import { accountStatement, ageAnalysis, createAccount, listAccounts, postAccountEntry } from '../domain/accounts.js'
import { DomainError } from '../domain/errors.js'
import { back, page, requireRole, run, type Env } from './app.js'
import { date, dateTime, money } from './layout.js'

export function accountRoutes() {
  const r = new Hono<Env>()

  r.get('/', async (c) => {
    const accounts = await run(c, (tx) => listAccounts(tx))
    const owed = accounts.reduce((a, x) => a + x.balance, 0)
    return page(c, 'Accounts', (
      <>
        <div class="row"><h1>Customer accounts</h1><span class="spacer" /><a class="btn secondary" href="/accounts/aging">Age analysis</a></div>
        <form method="post" action="/accounts" class="grid panel">
          <label>Account number<input name="accountNo" required maxlength={20} /></label>
          <label>Name<input name="name" required /></label>
          <label>Phone<input name="phone" /></label>
          <label>Credit limit (P)<input name="creditLimit" type="number" step="0.01" min="0" /></label>
          <div><button>Add account</button></div>
        </form>
        <p class="muted">{accounts.length} accounts owe {money(owed)} in total. New accounts reach the tills when they next refresh their item list (within 10 minutes, or on reload).</p>
        <div class="wrap"><table>
          <thead><tr><th>Account</th><th>Name</th><th>Phone</th><th class="n">Credit limit</th><th class="n">Balance</th><th>Last payment</th></tr></thead>
          <tbody>{accounts.map((a) => (
            <tr data-href={`/accounts/${a.id}`}><td><a href={`/accounts/${a.id}`}>{a.accountNo}</a></td><td>{a.name}</td><td>{a.phone}</td>
              <td class="n">{money(a.creditLimit)}</td>
              <td class={`n ${a.creditLimit !== null && a.balance > a.creditLimit ? 'neg' : ''}`}>{money(a.balance)}</td>
              <td>{date(a.lastPayment)}</td></tr>
          ))}</tbody>
        </table></div>
      </>
    ))
  })

  r.post('/', async (c) => {
    requireRole(c, ['owner', 'pharmacist'])
    const b = await c.req.parseBody()
    const limit = String(b.creditLimit ?? '').trim()
    const id = await run(c, (tx) => createAccount(tx, {
      accountNo: String(b.accountNo ?? ''), name: String(b.name ?? ''), phone: String(b.phone ?? ''), creditLimit: limit ? Number(limit) : null,
    }, c.get('user').userId))
    return c.redirect(`/accounts/${id}`)
  })

  r.get('/aging', async (c) => {
    const rows = await run(c, (tx) => ageAnalysis(tx))
    const tot = rows.reduce((a, x) => ({ balance: a.balance + x.balance, current: a.current + x.current, d30: a.d30 + x.d30, d60: a.d60 + x.d60, d90: a.d90 + x.d90 }),
      { balance: 0, current: 0, d30: 0, d60: 0, d90: 0 })
    return page(c, 'Age analysis', (
      <>
        <h1>Debtors age analysis</h1>
        <p class="muted">Payments clear the oldest charges first. Days are counted from the sale.</p>
        <div class="wrap"><table>
          <thead><tr><th>Account</th><th>Name</th><th class="n">Current</th><th class="n">31-60 days</th><th class="n">61-90 days</th><th class="n">Over 90</th><th class="n">Balance</th><th class="n">Limit</th></tr></thead>
          <tbody>{rows.map((x) => (
            <tr data-href={`/accounts/${x.id}`}><td>{x.accountNo}</td><td>{x.name}</td><td class="n">{money(x.current)}</td><td class="n">{money(x.d30)}</td>
              <td class="n">{money(x.d60)}</td><td class={`n ${x.d90 > 0 ? 'neg' : ''}`}>{money(x.d90)}</td><td class="n"><b>{money(x.balance)}</b></td><td class="n">{money(x.creditLimit)}</td></tr>
          ))}</tbody>
          <tfoot><tr><td colspan={2}><b>Total</b></td><td class="n">{money(tot.current)}</td><td class="n">{money(tot.d30)}</td><td class="n">{money(tot.d60)}</td>
            <td class="n">{money(tot.d90)}</td><td class="n"><b>{money(tot.balance)}</b></td><td /></tr></tfoot>
        </table></div>
      </>
    ))
  })

  r.get('/:id', async (c) => {
    const a = await run(c, (tx) => accountStatement(tx, c.req.param('id')))
    if (!a) throw new DomainError('unknown account', 'not_found', 404)
    return page(c, a.name, (
      <>
        <h1>{a.name} <span class="muted">account {a.accountNo}</span></h1>
        <div class="stats">
          <div class="stat"><b class={a.creditLimit !== null && a.balance > a.creditLimit ? 'neg' : ''}>{money(a.balance)}</b><span>owed now</span></div>
          <div class="stat"><b>{a.creditLimit === null ? 'none' : money(a.creditLimit)}</b><span>credit limit</span></div>
          {a.phone && <div class="stat"><b style="font-size:16px">{a.phone}</b><span>phone</span></div>}
        </div>
        <h2>Statement</h2>
        <div class="wrap"><table>
          <thead><tr><th>Date</th><th>What</th><th>By</th><th class="n">Charged</th><th class="n">Paid</th><th class="n">Balance</th></tr></thead>
          <tbody>{a.entries.map((e) => (
            <tr><td>{dateTime(e.occurredAt)}</td>
              <td>{e.saleId ? <a href={`/sales/${e.saleId}`}>{e.amount < 0 ? 'Refund' : 'Sale'} {e.saleNo}</a> : e.kind === 'payment' ? 'Payment' : 'Adjustment'}{e.note && <span class="muted"> · {e.note}</span>}</td>
              <td>{e.userName}</td>
              <td class="n">{e.amount > 0 ? money(e.amount) : ''}</td><td class="n">{e.amount < 0 ? money(-e.amount) : ''}</td><td class="n">{money(e.balance)}</td></tr>
          ))}</tbody>
        </table></div>
        <h2>Record a payment or correction</h2>
        <form method="post" action={`/accounts/${a.id}/entries`} class="grid panel">
          <label>What<select name="kind"><option value="payment">Payment received outside the till</option><option value="adjustment">Correction (+ owes more, − owes less)</option></select></label>
          <label>Amount (P)<input name="amount" type="number" step="0.01" required /></label>
          <label>Note<input name="note" required placeholder="e.g. bank transfer 12 Oct" /></label>
          <div><button>Record</button></div>
        </form>
        <p class="hint">Payments taken at the till (F10 there) go into that till's cash-up. Use this form only for money that never went through a till.</p>
      </>
    ))
  })

  r.post('/:id/entries', async (c) => {
    requireRole(c, ['owner', 'pharmacist'])
    const b = await c.req.parseBody()
    const kind = b.kind === 'adjustment' ? 'adjustment' : 'payment'
    await run(c, (tx) => postAccountEntry(tx, c.req.param('id'), { kind, amount: Number(b.amount), note: String(b.note ?? '') }, c.get('user').userId))
    return back(c, `/accounts/${c.req.param('id')}`, { ok: kind === 'payment' ? 'Payment recorded' : 'Correction recorded' })
  })

  return r
}
