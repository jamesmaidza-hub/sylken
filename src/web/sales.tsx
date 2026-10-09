import { Hono } from 'hono'
import { DomainError } from '../domain/errors.js'
import { listSales } from '../domain/sales.js'
import { getSale, tenderLabels } from '../domain/till.js'
import { formatPacks } from '../domain/units.js'
import { page, run, type Env } from './app.js'
import { rangeFrom, RangeForm, SalesTable } from './cashup.js'
import { dateTime, money } from './layout.js'

export function salesRoutes() {
  const r = new Hono<Env>()

  r.get('/', async (c) => {
    const range = await rangeFrom(c)
    const sales = await run(c, (tx) => listSales(tx, { range }))
    const total = sales.reduce((a, s) => a + s.total, 0)
    return page(c, 'Sales', (
      <>
        <h1>Sales journal</h1>
        <RangeForm {...range} />
        <p class="muted">{sales.length} sales and refunds, {money(total)} incl VAT{sales.length === 500 && ' (showing the latest 500)'}.</p>
        <SalesTable sales={sales} />
      </>
    ))
  })

  r.get('/:id', async (c) => {
    const s = await run(c, (tx) => getSale(tx, c.req.param('id')))
    if (!s) throw new DomainError('unknown sale', 'not_found', 404)
    return page(c, `Sale ${s.saleNo}`, (
      <>
        <h1>{s.kind === 'refund' ? 'Refund' : 'Sale'} {s.saleNo}</h1>
        <p class="muted">{dateTime(s.occurredAt)} · till {s.tillCode}, run {s.runNo} · {s.userName ?? 'unknown assistant'}
          {s.accountName && ` · account ${s.accountName} (${s.accountNo})`}{s.medicalAid && ` · ${s.medicalAid}${s.memberNo ? ` member ${s.memberNo}` : ''}`}
          {s.refundOf && <> · refund of <a href={`/sales/${s.refundOf}`}>an earlier sale</a></>}</p>
        {s.late && <div class="msg err">This sale reached the server after its run was cashed up.</div>}
        <div class="wrap"><table>
          <thead><tr><th>#</th><th>Code</th><th>Item</th><th class="n">Qty</th><th class="n">List</th><th class="n">Charged</th><th class="n">VAT</th></tr></thead>
          <tbody>{s.lines.map((l) => (
            <tr data-href={`/items/${l.itemId}`}><td>{l.lineNo}</td><td>{l.stockCode}</td><td>{l.description}</td><td class="n">{formatPacks(l.qtyUnits, l.packSize)}</td>
              <td class="n">{l.listTotal !== l.lineTotal ? <span class="muted">{money(l.listTotal)}</span> : ''}</td><td class="n">{money(l.lineTotal)}</td><td class="n">{money(l.vat)}</td></tr>
          ))}</tbody>
          <tfoot>
            <tr><td colspan={5} class="n"><b>Total incl VAT</b></td><td class="n"><b>{money(s.total)}</b></td><td class="n">{money(s.vat)}</td></tr>
            {s.payments.map((p) => <tr><td colspan={5} class="n">{tenderLabels[p.tender]}{p.reference && ` (${p.reference})`}</td><td class="n">{money(p.amount)}</td><td /></tr>)}
            {s.cashTendered !== null && <tr><td colspan={5} class="n muted">Cash tendered {money(s.cashTendered)}, change</td><td class="n">{money(s.change)}</td><td /></tr>}
            <tr><td colspan={5} class="n muted">Cost excl VAT · GP</td><td class="n muted">{money(s.cost)}</td><td class="n muted">{money(Math.round((s.total - s.vat - s.cost) * 100) / 100)}</td></tr>
          </tfoot>
        </table></div>
        <p class="hint">Sales are never changed. To put a mistake right, ring up a refund on the till (F8).</p>
      </>
    ))
  })

  return r
}
