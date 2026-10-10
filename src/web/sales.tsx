import { Hono } from 'hono'
import { DomainError } from '../domain/errors.js'
import { listSales } from '../domain/sales.js'
import { getSale, tenderLabels } from '../domain/till.js'
import { formatPacks } from '../domain/units.js'
import { getSettings } from '../domain/settings.js'
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
        <div class="row"><h1>Sales journal</h1><span class="spacer" /><a class="btn secondary" href={`/reports/till/journal?from=${range.from}&to=${range.to}`}>Report with downloads</a></div>
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
        <div class="row"><h1>{s.kind === 'refund' ? 'Refund' : 'Sale'} {s.saleNo}</h1><span class="spacer" />
          <a class="btn secondary" href={`/sales/${s.id}/slip`} target="_blank">Reprint slip</a></div>
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

  /** A copy of the till slip, laid out for the slip printer, marked as a copy. */
  r.get('/:id/slip', async (c) => {
    const { s, t } = await run(c, async (tx) => ({ s: await getSale(tx, c.req.param('id')), t: await getSettings(tx) }))
    if (!s) throw new DomainError('unknown sale', 'not_found', 404)
    const change = s.change ?? 0
    return c.html(
      <html><head><meta charset="utf-8" /><title>Slip {s.saleNo}</title>
        <style>{`body{font:12px/1.35 ui-monospace,monospace;width:72mm;margin:8px auto;color:#000;background:#fff}h3{font-size:14px;margin:0 0 2px;text-align:center}
.c{text-align:center}table{width:100%;border-collapse:collapse}td{padding:1px 0;vertical-align:top}td.n{text-align:right;white-space:nowrap}
hr{border:0;border-top:1px dashed #000;margin:4px 0}@media print{body{margin:0}.noprint{display:none}@page{margin:4mm}}`}</style></head>
      <body onload="window.print()">
        <h3>{c.get('user').tenantName}</h3>
        {t.vatNumber && <div class="c">VAT no {t.vatNumber}</div>}
        <div class="c">{s.kind === 'refund' ? 'REFUND' : 'TAX INVOICE'} · COPY</div>
        <div>{dateTime(s.occurredAt)} · {s.tillCode} sale {s.saleNo} · {s.userName ?? ''}</div>
        {s.accountName && <div>Account {s.accountNo} {s.accountName}</div>}
        {s.medicalAid && <div>{s.medicalAid} {s.memberNo ?? ''}</div>}
        <hr />
        <table>{s.lines.map((l) => <tr><td>{l.description}<br />{formatPacks(l.qtyUnits, l.packSize)}</td><td class="n">{money(l.lineTotal)}</td></tr>)}</table>
        <hr />
        <table>
          <tr><td><b>Total incl VAT</b></td><td class="n"><b>{money(s.total)}</b></td></tr>
          <tr><td>VAT included</td><td class="n">{money(s.vat)}</td></tr>
          {s.rounding !== 0 && <><tr><td>Cash rounding</td><td class="n">{money(s.rounding)}</td></tr>
            <tr><td><b>Paid</b></td><td class="n"><b>{money(Math.round((s.total + s.rounding) * 100) / 100)}</b></td></tr></>}
          {s.payments.map((p) => <tr><td>{tenderLabels[p.tender]}</td><td class="n">{money(p.tender === 'cash' && change ? p.amount + change : p.amount)}</td></tr>)}
          {change > 0 && <tr><td>Change</td><td class="n">{money(change)}</td></tr>}
        </table>
        {t.receiptFooter && <><hr /><div class="c">{t.receiptFooter}</div></>}
        <p class="noprint c"><a href={`/sales/${s.id}`}>Back to the sale</a></p>
      </body></html>,
    )
  })

  return r
}
