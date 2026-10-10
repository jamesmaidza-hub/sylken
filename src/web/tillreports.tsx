import { Hono } from 'hono'
import { listAccounts } from '../domain/accounts.js'
import {
  accountStatements, accountTransactions, assistantSales, auditLabels, auditLog, contacts, debtors, markupReport, otcSales, pettyCash,
  salesDetail, salesJournal, tillPriceAlterations,
} from '../domain/tillreports.js'
import { tenderLabels, type Tender } from '../domain/till.js'
import { page, run, type Env } from './app.js'
import { rangeFrom, thisMonth } from './cashup.js'
import { download, formatHref } from './export.js'
import { date, dateTime, money, qty } from './layout.js'
import { file, ReportPage as Report, type ScreenCol } from './report.js'

export const tillReportList: [string, string, string][] = [
  ['/reports/till/statements', 'Account statements', 'Opening balance, charges, payments and closing balance per account, ready to print'],
  ['/reports/till/debtors', 'Debtors', 'What each account owes as at a date, by age, with limits and last payment'],
  ['/reports/till/account-transactions', 'Account transactions', 'Every charge, payment and correction on accounts'],
  ['/reports/till/journal', 'Sales journal', 'Every sale and refund with tenders, and reprint any slip'],
  ['/reports/till/detail', 'Sales detail', 'Every line rung up: item, quantity, price, discount and GP'],
  ['/reports/till/assistants', 'Assistants', 'Sales, refunds, discounts and GP per assistant'],
  ['/reports/till/petty-cash', 'Petty cash', 'Cash paid out of the drawers, and what for'],
  ['/reports/till/price-alterations', 'Price alterations', 'Lines sold at a price different from the item price'],
  ['/reports/till/markup', 'Markup', 'Markup and GP per item, and prices off the markup rule'],
  ['/reports/till/otc', 'OTC sales', 'Items sold over the counter, not paying for a script'],
  ['/reports/till/contacts', 'Contact list', 'Phone numbers for customer accounts and patients'],
  ['/reports/till/audit', 'Audit log', 'Who changed what in the back office'],
]

export function tillReportRoutes() {
  const r = new Hono<Env>()

  // ------------------------------------------------------------ accounts

  r.get('/statements', async (c) => {
    const range = await rangeFrom(c, thisMonth)
    const accountId = c.req.query('account') || undefined
    const { st, accounts } = await run(c, async (tx) => ({ st: await accountStatements(tx, range, { accountId }), accounts: await listAccounts(tx) }))
    const flat = st.flatMap((a) => [
      { a, at: null, what: 'Opening balance', charged: null, paid: null, balance: a.opening, note: null, by: null },
      ...a.lines.map((l) => ({ a, ...l })),
      { a, at: null, what: 'Closing balance', charged: a.charged, paid: a.paid, balance: a.closing, note: null, by: null },
    ])
    const dl = await download(c, file('statements', range), 'Statements', [
      { h: 'Account', v: (x) => x.a.accountNo }, { h: 'Name', v: (x) => x.a.name }, { h: 'Date', v: (x) => (x.at ? dateTime(x.at) : null) },
      { h: 'Entry', v: (x) => x.what }, { h: 'Charged', v: (x) => x.charged || null, fmt: 'money' }, { h: 'Paid', v: (x) => x.paid || null, fmt: 'money' },
      { h: 'Balance', v: (x) => x.balance, fmt: 'money' }, { h: 'Note', v: (x) => x.note }, { h: 'By', v: (x) => x.by },
    ], flat)
    if (dl) return dl
    return page(c, 'Account statements', (
      <>
        <style>{'@media print{.statement{break-after:page;border:0}.statement:last-child{break-after:auto}}'}</style>
        <Report c={c} title="Account statements" range={range} keep={accountId ? `account=${accountId}` : ''} cols={[]} rows={[]} noTable
          intro="One statement per account: what it owed at the start, what was charged and paid, and what it owes at the end. Print gives one account per page."
          filters={<label class="f">Account<select name="account"><option value="">All with activity or a balance</option>
            {accounts.map((a) => <option value={a.id} selected={a.id === accountId}>{a.accountNo} {a.name}</option>)}</select></label>}
          summary={`${st.length} statements; ${money(st.reduce((s, a) => s + a.closing, 0))} owed at ${date(range.to)}.`} />
        {st.map((a) => (
          <div class="panel statement">
            <div class="row"><b style="font-size:16px"><a href={`/accounts/${a.id}`}>{a.name}</a></b><span class="muted">Account {a.accountNo}{a.phone ? ` · ${a.phone}` : ''}</span>
              <span class="spacer" /><span class="muted">{date(range.from)} to {date(range.to)}</span></div>
            <div class="wrap"><table>
              <thead><tr><th>Date</th><th>Entry</th><th>Note</th><th class="n">Charged</th><th class="n">Paid</th><th class="n">Balance</th></tr></thead>
              <tbody>
                <tr><td /><td><b>Opening balance</b></td><td /><td /><td /><td class="n">{money(a.opening)}</td></tr>
                {a.lines.map((l) => (
                  <tr data-href={l.saleId ? `/sales/${l.saleId}` : undefined}><td>{dateTime(l.at)}</td><td>{l.what}</td><td class="muted">{l.note}</td>
                    <td class="n">{l.charged ? money(l.charged) : ''}</td><td class="n">{l.paid ? money(l.paid) : ''}</td><td class="n">{money(l.balance)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><td /><td><b>Owing at {date(range.to)}</b></td><td /><td class="n">{money(a.charged)}</td><td class="n">{money(a.paid)}</td>
                <td class={`n ${a.creditLimit !== null && a.closing > a.creditLimit ? 'neg' : ''}`}><b>{money(a.closing)}</b></td></tr></tfoot>
            </table></div>
          </div>
        ))}
      </>
    ))
  })

  r.get('/debtors', async (c) => {
    const range = await rangeFrom(c)
    const asOf = range.to
    const rows = await run(c, (tx) => debtors(tx, asOf))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Account', v: (x) => x.accountNo }, { h: 'Name', v: (x) => x.name }, { h: 'Phone', v: (x) => x.phone },
      { h: 'Current', v: (x) => x.current, fmt: 'money' }, { h: '31-60 days', v: (x) => x.d30, fmt: 'money' }, { h: '61-90 days', v: (x) => x.d60, fmt: 'money' },
      { h: 'Over 90', v: (x) => x.d90, fmt: 'money', show: (x) => <span class={x.d90 > 0 ? 'neg' : ''}>{money(x.d90)}</span> },
      { h: 'Balance', v: (x) => x.balance, fmt: 'money', show: (x) => <b class={x.overLimit ? 'neg' : ''}>{money(x.balance)}</b> },
      { h: 'Limit', v: (x) => x.creditLimit, fmt: 'money' },
      { h: 'Last charge', v: (x) => (x.lastCharge ? date(x.lastCharge) : null) }, { h: 'Last payment', v: (x) => (x.lastPayment ? date(x.lastPayment) : null) },
    ]
    const sum = (k: 'current' | 'd30' | 'd60' | 'd90' | 'balance') => Math.round(rows.reduce((s, x) => s + x[k], 0) * 100) / 100
    const foot = { id: '', accountNo: 'Total', name: '', phone: null, current: sum('current'), d30: sum('d30'), d60: sum('d60'), d90: sum('d90'),
      balance: sum('balance'), creditLimit: null, lastCharge: null, lastPayment: null, overLimit: false } as R
    const dl = await download(c, `debtors-${asOf}`, 'Debtors', cols, [...rows, foot])
    if (dl) return dl
    return page(c, 'Debtors', <Report c={c} title="Debtors" cols={cols} rows={rows} foot={foot}
      intro="What each customer account owes at the end of the day chosen, aged from the sale. Payments clear the oldest charges first. Red balances are over the credit limit."
      filters={<label class="f">As at<input type="date" name="to" value={asOf} /></label>}
      summary={`${rows.length} accounts owe ${money(foot.balance)} as at ${date(asOf)}; ${rows.filter((x) => x.overLimit).length} over their limit.`}
      href={(x) => `/accounts/${x.id}`} />)
  })

  r.get('/account-transactions', async (c) => {
    const range = await rangeFrom(c, thisMonth)
    const kind = c.req.query('kind') ?? ''
    const rows = await run(c, (tx) => accountTransactions(tx, range, { kind: kind || undefined }))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Date', v: (x) => dateTime(x.at) }, { h: 'Account', v: (x) => x.accountNo }, { h: 'Name', v: (x) => x.name },
      { h: 'Entry', v: (x) => x.what, show: (x) => (x.saleId ? <a href={`/sales/${x.saleId}`}>{x.what}</a> : x.what) },
      { h: 'Where', v: (x) => x.where }, { h: 'Charged', v: (x) => x.charged || null, fmt: 'money' }, { h: 'Paid', v: (x) => x.paid || null, fmt: 'money' },
      { h: 'Note', v: (x) => x.note }, { h: 'By', v: (x) => x.by },
    ]
    const dl = await download(c, file('account-transactions', range), 'Account transactions', cols, rows)
    if (dl) return dl
    const ch = rows.reduce((s, x) => s + x.charged, 0), pd = rows.reduce((s, x) => s + x.paid, 0)
    return page(c, 'Account transactions', <Report c={c} title="Account transactions" range={range} cols={cols} rows={rows}
      keep={kind ? `kind=${kind}` : ''}
      intro="Every entry on customer accounts: sales put on account at the till, payments at the till or in the back office, and corrections."
      filters={<label class="f">Type<select name="kind"><option value="">All</option>
        {[['charge', 'Charges'], ['payment', 'Payments'], ['adjustment', 'Corrections']].map(([k, l]) => <option value={k} selected={kind === k}>{l}</option>)}</select></label>}
      summary={`${rows.length} entries: ${money(ch)} charged, ${money(pd)} paid.`}
      href={(x) => `/accounts/${x.accountId}`} />)
  })

  // ------------------------------------------------------------ sales

  r.get('/journal', async (c) => {
    const no = (c.req.query('no') ?? '').trim()
    if (no) {
      const [s] = await run(c, (tx) => tx`select id from sales where sale_no = ${Number(no) || 0}`)
      if (s) return c.redirect(`/sales/${s.id}`)
    }
    const range = await rangeFrom(c)
    const rows = await run(c, (tx) => salesJournal(tx, range))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Sale', v: (x) => x.saleNo, fmt: 'int', show: (x) => <><a href={`/sales/${x.id}`}>{x.saleNo}</a>{x.kind === 'refund' && <span class="chip">refund</span>}</> },
      { h: 'Time', v: (x) => dateTime(x.at) }, { h: 'Till', v: (x) => x.till }, { h: 'Assistant', v: (x) => x.assistant },
      { h: 'Account', v: (x) => x.account }, { h: 'Medical aid', v: (x) => x.medicalAid }, { h: 'Script', v: (x) => x.scriptNo, fmt: 'int' },
      { h: 'Items', v: (x) => x.lines, fmt: 'int' }, { h: 'Paid by', v: (x) => x.tenders },
      { h: 'Discount', v: (x) => x.discount || null, fmt: 'money' }, { h: 'Total incl VAT', v: (x) => x.total, fmt: 'money' },
      { h: 'VAT', v: (x) => x.vat, fmt: 'money' }, { h: 'GP', v: (x) => x.gp, fmt: 'money' },
      { h: 'Slip', v: () => null, show: (x) => <a href={`/sales/${x.id}/slip`} target="_blank">Reprint</a> },
    ]
    const exportCols = cols.filter((x) => x.h !== 'Slip')
    const dl = await download(c, file('sales-journal', range), 'Sales journal', exportCols, rows)
    if (dl) return dl
    return page(c, 'Sales journal', <Report c={c} title="Sales journal" range={range} cols={cols} rows={rows}
      intro="Every sale and refund in the range, oldest first, with how it was paid. Reprint gives a copy of the till slip."
      before={<form class="row" action="/reports/till/journal"><input name="no" inputmode="numeric" placeholder="Sale number" style="width:140px" />
        <button class="secondary">Find sale</button>{no && <span class="neg">There is no sale number {no}.</span>}</form>}
      summary={`${rows.filter((x) => x.kind === 'sale').length} sales and ${rows.filter((x) => x.kind === 'refund').length} refunds, ${money(rows.reduce((s, x) => s + x.total, 0))} incl VAT.`}
      href={(x) => `/sales/${x.id}`} />)
  })

  r.get('/detail', async (c) => {
    const range = await rangeFrom(c)
    const q = (c.req.query('q') ?? '').trim()
    const rows = await run(c, (tx) => salesDetail(tx, range, { q: q || undefined }))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Sale', v: (x) => x.saleNo, fmt: 'int' }, { h: 'Time', v: (x) => dateTime(x.at) }, { h: 'Assistant', v: (x) => x.assistant },
      { h: 'Script', v: (x) => x.scriptNo, fmt: 'int' }, { h: 'Code', v: (x) => x.stockCode }, { h: 'Description', v: (x) => x.description },
      { h: 'Units', v: (x) => x.units, fmt: 'int', show: (x) => qty(x.units, x.packSize) },
      { h: 'Item price', v: (x) => x.list, fmt: 'money' }, { h: 'Charged', v: (x) => x.total, fmt: 'money' },
      { h: 'Discount', v: (x) => x.discount || null, fmt: 'money' }, { h: 'VAT', v: (x) => x.vat, fmt: 'money' },
      { h: 'Cost', v: (x) => x.cost, fmt: 'money' }, { h: 'GP', v: (x) => x.gp, fmt: 'money', show: (x) => <span class={x.gp < 0 ? 'neg' : ''}>{money(x.gp)}</span> },
    ]
    const dl = await download(c, file('sales-detail', range), 'Sales detail', cols, rows)
    if (dl) return dl
    return page(c, 'Sales detail', <Report c={c} title="Sales detail" range={range} cols={cols} rows={rows}
      keep={q ? `q=${encodeURIComponent(q)}` : ''}
      intro="Every line rung up at the till in the range. Item price is the price at the time; discount is how much less was charged."
      filters={<label class="f">Item<input name="q" value={q} placeholder="Name or code" /></label>}
      summary={`${rows.length} lines, ${money(rows.reduce((s, x) => s + x.total, 0))} incl VAT.`}
      href={(x) => `/sales/${x.saleId}`} />)
  })

  r.get('/assistants', async (c) => {
    const range = await rangeFrom(c, thisMonth)
    const rows = await run(c, (tx) => assistantSales(tx, range))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Assistant', v: (x) => x.name }, { h: 'Sales', v: (x) => x.sales, fmt: 'int' }, { h: 'Items', v: (x) => x.units, fmt: 'int' },
      { h: 'Refunds', v: (x) => x.refunds, fmt: 'int' }, { h: 'Refunded', v: (x) => x.refunded || null, fmt: 'money' },
      { h: 'Takings incl VAT', v: (x) => x.total, fmt: 'money' }, { h: 'Per sale', v: (x) => x.perSale, fmt: 'money' },
      { h: 'Discount given', v: (x) => x.discount || null, fmt: 'money' }, { h: 'Excl VAT', v: (x) => x.excl, fmt: 'money' },
      { h: 'GP', v: (x) => x.gp, fmt: 'money' }, { h: 'GP %', v: (x) => x.gpPct, fmt: 'pct' },
      { h: 'Account payments taken', v: (x) => x.accountPayments || null, fmt: 'money' }, { h: 'Petty cash paid out', v: (x) => x.pettyCash || null, fmt: 'money' },
    ]
    const dl = await download(c, file('assistants', range), 'Assistants', cols, rows)
    if (dl) return dl
    return page(c, 'Assistants', <Report c={c} title="Assistants" range={range} cols={cols} rows={rows}
      intro="What each person rang up at the till: sales, refunds, discounts and GP, plus account payments they took and petty cash they paid out."
      summary={`${rows.length} people; ${money(rows.reduce((s, x) => s + x.total, 0))} taken in the range.`}
      hint="Per sale is takings before refunds divided by the number of sales. GP is on the price excl VAT at the cost when sold." />)
  })

  r.get('/petty-cash', async (c) => {
    const range = await rangeFrom(c, thisMonth)
    const rows = await run(c, (tx) => pettyCash(tx, range))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Date', v: (x) => dateTime(x.at) }, { h: 'Till', v: (x) => x.till }, { h: 'Paid from', v: (x) => tenderLabels[x.tender as Tender] ?? x.tender },
      { h: 'Amount', v: (x) => x.amount, fmt: 'money' }, { h: 'What for', v: (x) => x.note }, { h: 'By', v: (x) => x.by },
    ]
    const dl = await download(c, file('petty-cash', range), 'Petty cash', cols, rows)
    if (dl) return dl
    return page(c, 'Petty cash', <Report c={c} title="Petty cash" range={range} cols={cols} rows={rows}
      intro="Cash paid out of the till drawers that was not a refund. It is taken off the cash expected at cash-up."
      summary={`${rows.length} payouts, ${money(rows.reduce((s, x) => s + x.amount, 0))} in total.`} />)
  })

  r.get('/price-alterations', async (c) => {
    const range = await rangeFrom(c, thisMonth)
    const rows = await run(c, (tx) => tillPriceAlterations(tx, range))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Sale', v: (x) => x.saleNo, fmt: 'int' }, { h: 'Time', v: (x) => dateTime(x.at) }, { h: 'Assistant', v: (x) => x.assistant },
      { h: 'Code', v: (x) => x.stockCode }, { h: 'Description', v: (x) => x.description },
      { h: 'Units', v: (x) => x.units, fmt: 'int', show: (x) => qty(x.units, x.packSize) },
      { h: 'Item price', v: (x) => x.list, fmt: 'money' }, { h: 'Charged', v: (x) => x.total, fmt: 'money' },
      { h: 'Difference', v: (x) => -x.discount, fmt: 'money', show: (x) => <span class={x.discount > 0 ? 'neg' : 'pos'}>{money(-x.discount)}</span> },
      { h: 'Change %', v: (x) => x.changePct, fmt: 'pct' }, { h: 'GP', v: (x) => x.gp, fmt: 'money' },
    ]
    const dl = await download(c, file('price-alterations', range), 'Price alterations', cols, rows)
    if (dl) return dl
    return page(c, 'Price alterations', <Report c={c} title="Price alterations" range={range} cols={cols} rows={rows}
      intro="Lines rung up at a price different from the item's price at the time, such as discounts and price overrides at the till."
      summary={`${rows.length} lines altered; ${money(rows.reduce((s, x) => s + x.discount, 0))} less charged than the item prices.`}
      href={(x) => `/sales/${x.saleId}`}
      hint="Script prices are worked out from the item price, so they never differ; price changes on items themselves are in the Price changes report." />)
  })

  r.get('/otc', async (c) => {
    const range = await rangeFrom(c, thisMonth)
    const rows = await run(c, (tx) => otcSales(tx, range))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Code', v: (x) => x.stockCode }, { h: 'Description', v: (x) => x.description }, { h: 'Schedule', v: (x) => x.schedule, fmt: 'int' },
      { h: 'Sales', v: (x) => x.sales, fmt: 'int' }, { h: 'Units', v: (x) => x.units, fmt: 'int' }, { h: 'Packs', v: (x) => +(x.units / x.packSize).toFixed(3), fmt: 'qty' },
      { h: 'Value incl VAT', v: (x) => x.total, fmt: 'money' }, { h: 'Excl VAT', v: (x) => x.excl, fmt: 'money' }, { h: 'Cost', v: (x) => x.cost, fmt: 'money' },
      { h: 'GP', v: (x) => x.gp, fmt: 'money' }, { h: 'GP %', v: (x) => x.gpPct, fmt: 'pct' }, { h: 'Discount', v: (x) => x.discount || null, fmt: 'money' },
    ]
    const dl = await download(c, file('otc-sales', range), 'OTC sales', cols, rows)
    if (dl) return dl
    const t = rows.reduce((a, x) => ({ total: a.total + x.total, gp: a.gp + x.gp, excl: a.excl + x.excl }), { total: 0, gp: 0, excl: 0 })
    return page(c, 'OTC sales', <Report c={c} title="OTC sales" range={range} cols={cols} rows={rows}
      intro="Items sold over the counter, biggest value first. Scripts paid at the till are left out; they are in Drug usage."
      summary={`${rows.length} items sold for ${money(t.total)} incl VAT, GP ${money(t.gp)}${t.excl ? ` (${((t.gp / t.excl) * 100).toFixed(1)}%)` : ''}.`}
      href={(x) => `/items/${x.itemId}`} />)
  })

  // ------------------------------------------------------------ items, contacts, audit

  r.get('/markup', async (c) => {
    const n = (k: string) => (c.req.query(k) ?? '').trim()
    const below = n('below'), above = n('above'), q = n('q'), off = c.req.query('off') === 'on'
    const rows = await run(c, (tx) => markupReport(tx, {
      below: below ? Number(below) : undefined, above: above ? Number(above) : undefined, offRule: off, q: q || undefined,
    }))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Code', v: (x) => x.stockCode }, { h: 'Description', v: (x) => x.description },
      { h: 'Cost excl VAT', v: (x) => x.cost, fmt: 'money' }, { h: 'Price incl VAT', v: (x) => x.retail, fmt: 'money' },
      { h: 'Markup excl VAT', v: (x) => x.markupExcl, fmt: 'pct' }, { h: 'Markup incl VAT', v: (x) => x.markupIncl, fmt: 'pct' },
      { h: 'GP %', v: (x) => x.gpPct, fmt: 'pct' },
      { h: 'Set markup', v: (x) => x.setMarkup, fmt: 'pct', show: (x) => <>{x.setMarkup}%{x.own && <span class="chip">own</span>}</> },
      { h: 'Price by markup', v: (x) => x.rulePrice, fmt: 'money' },
      { h: 'Difference', v: (x) => x.difference || null, fmt: 'money', show: (x) => (x.difference ? <span class={x.difference < 0 ? 'neg' : 'pos'}>{money(x.difference)}</span> : '') },
    ]
    const dl = await download(c, 'markup', 'Markup', cols, rows)
    if (dl) return dl
    return page(c, 'Markup', <Report c={c} title="Markup" cols={cols} rows={rows}
      intro="Active items with a cost, lowest markup first. Markup is on cost; price by markup is what the item's markup rule gives from today's cost."
      filters={<>
        <label class="f">Markup below %<input name="below" type="number" step="any" value={below} style="width:110px" /></label>
        <label class="f">Markup above %<input name="above" type="number" step="any" value={above} style="width:110px" /></label>
        <label class="f">Item<input name="q" value={q} placeholder="Name or code" /></label>
        <label class="row"><input type="checkbox" name="off" checked={off} /> Only prices off the markup rule</label>
      </>}
      summary={`${rows.length} items.`}
      href={(x) => `/items/${x.itemId}`} />)
  })

  r.get('/contacts', async (c) => {
    const kind = (['account', 'patient'].includes(c.req.query('kind') ?? '') ? c.req.query('kind') : undefined) as 'account' | 'patient' | undefined
    const phone = c.req.query('phone') === 'on'
    const q = (c.req.query('q') ?? '').trim()
    const rows = await run(c, (tx) => contacts(tx, { kind, withPhone: phone, q: q || undefined }))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Name', v: (x) => x.name }, { h: 'Type', v: (x) => x.kind }, { h: 'Account / member no', v: (x) => x.ref },
      { h: 'Phone', v: (x) => x.phone }, { h: 'Address', v: (x) => x.address }, { h: 'Medical aid / balance', v: (x) => x.detail },
      { h: 'Last visit', v: (x) => (x.last ? date(x.last) : null) },
    ]
    const dl = await download(c, 'contacts', 'Contacts', cols, rows)
    if (dl) return dl
    return page(c, 'Contact list', <Report c={c} title="Contact list" cols={cols} rows={rows}
      intro="Active customer accounts and patients with their phone numbers. A dependant without a phone shows the main member's."
      filters={<>
        <label class="f">Show<select name="kind"><option value="">Accounts and patients</option>
          <option value="account" selected={kind === 'account'}>Accounts</option><option value="patient" selected={kind === 'patient'}>Patients</option></select></label>
        <label class="f">Name<input name="q" value={q} /></label>
        <label class="row"><input type="checkbox" name="phone" checked={phone} /> Only with a phone number</label>
      </>}
      summary={`${rows.length} contacts.`}
      href={(x) => x.href} />)
  })

  r.get('/audit', async (c) => {
    const range = await rangeFrom(c)
    const userId = c.req.query('user') || undefined
    const entity = c.req.query('entity') || undefined
    const { rows, users } = await run(c, async (tx) => ({
      rows: await auditLog(tx, range, { userId, entity }),
      users: await tx`select id, name from users order by name`,
    }))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'When', v: (x) => dateTime(x.at) }, { h: 'Who', v: (x) => x.by }, { h: 'Did', v: (x) => x.action },
      { h: 'To', v: (x) => x.entity, show: (x) => (x.href ? <a href={x.href}>{x.entity}</a> : x.entity) },
      { h: 'Details', v: (x) => x.detail, show: (x) => <code style="font-size:11px;word-break:break-all">{x.detail}</code> },
    ]
    const dl = await download(c, file('audit-log', range), 'Audit log', cols, rows)
    if (dl) return dl
    return page(c, 'Audit log', <Report c={c} title="Audit log" range={range} cols={cols} rows={rows}
      keep={[userId && `user=${userId}`, entity && `entity=${entity}`].filter(Boolean).join('&')}
      intro="Changes made in the back office and dispensary, newest first: items, prices, patients, scripts, accounts, stock takes and cash-ups. Sales are in the sales journal."
      filters={<>
        <label class="f">Who<select name="user"><option value="">Everyone</option>{users.map((u: any) => <option value={u.id} selected={u.id === userId}>{u.name}</option>)}</select></label>
        <label class="f">What<select name="entity"><option value="">Everything</option>
          {Object.entries(auditLabels).map(([k, l]) => <option value={k} selected={k === entity}>{l}</option>)}</select></label>
      </>}
      summary={`${rows.length} changes${rows.length === 5000 ? ' (the latest 5,000)' : ''}.`} />)
  })

  return r
}
