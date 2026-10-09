import { Hono } from 'hono'
import { num } from '../db/index.js'
import { applyMinMaxSuggestions, minMaxOrderReport, suggestMinMax } from '../domain/minmax.js'
import * as reports from '../domain/reports.js'
import { dailySales, itemGp } from '../domain/sales.js'
import { tenderLabels, type Tender } from '../domain/till.js'
import { rangeFrom, RangeForm } from './cashup.js'
import { back, page, requireRole, run, type Env } from './app.js'
import { dateTime, money, qty } from './layout.js'

const csv = (rows: (string | number | null)[][]) =>
  rows.map((r) => r.map((v) => (v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\n')

export function reportRoutes() {
  const r = new Hono<Env>()

  r.get('/', (c) => page(c, 'Reports', (
    <>
      <h1>Reports</h1>
      <div class="stats">
        {[
          ['/reports/sales', 'Daily sales', 'Takings, VAT, cost and GP per day, by tender and assistant'],
          ['/reports/sales-gp', 'Sales GP per item', 'What sold, at what margin, and discounts given'],
          ['/cashup', 'Cash-up', 'Cash analysis per till run, payments, bank deposit and turnover'],
          ['/accounts/aging', 'Debtors age analysis', 'What customer accounts owe, by age'],
          ['/reports/minmax', 'Min/max order', 'Items at or below minimum, with order quantities'],
          ['/reports/minmax/suggest', 'Min/max from usage', 'Suggested levels from average daily sales'],
          ['/reports/valuation', 'Stock value', 'Stock on hand at cost and at retail'],
          ['/reports/negative', 'Negative stock', 'Items sold or dispensed without being received'],
          ['/reports/dormant', 'Dormant stock', 'Stock on the shelf that has not sold in 6 months'],
          ['/reports/adjustments', 'Adjustments', 'Adjustments and stock take differences'],
          ['/reports/gp', 'GP exceptions', 'Items below cost or under 10% GP'],
          ['/reports/quarantine', 'Quarantined items', 'Imported records that need fixing before sale'],
        ].map(([href, title, desc]) => <a class="stat" href={href}><b style="font-size:16px">{title}</b><span>{desc}</span></a>)}
      </div>
    </>
  )))

  r.get('/minmax', async (c) => {
    const bin = c.req.query('bin') || undefined
    const lines = await run(c, (tx) => minMaxOrderReport(tx, { binName: bin }))
    if (c.req.query('format') === 'csv') {
      c.header('content-type', 'text/csv')
      c.header('content-disposition', 'attachment; filename="minmax-order.csv"')
      return c.body(csv([
        ['Stock code', 'Description', 'Pack size', 'On hand (packs)', 'Min (packs)', 'Max (packs)', 'Order (packs)', 'Order whole packs', 'Cost per pack', 'Order value', 'Bins'],
        ...lines.map((l) => [l.stockCode, l.description, l.packSize, l.onHandUnits / l.packSize, l.minUnits / l.packSize, l.maxUnits / l.packSize, l.orderPacks, l.orderPacksWhole, l.costPerPack, l.orderValue.toFixed(2), l.bins.join(' ')]),
      ]))
    }
    const total = lines.reduce((s, l) => s + l.orderValue, 0)
    return page(c, 'Min/max order', (
      <>
        <div class="row"><h1>Min/max order</h1><span class="spacer" /><a class="btn secondary" href={`?format=csv${bin ? `&bin=${encodeURIComponent(bin)}` : ''}`}>Download CSV</a></div>
        <p class="muted">{lines.length} items at or below their minimum. Ordering up to max in whole packs costs about {money(total)} excl VAT.</p>
        <form class="row"><input name="bin" value={bin ?? ''} placeholder="Filter by bin, e.g. VITAMINS" /><button class="secondary">Filter</button></form>
        <div class="wrap"><table>
          <thead><tr><th>Code</th><th>Description</th><th class="n">Pack</th><th class="n">On hand</th><th class="n">Min</th><th class="n">Max</th><th class="n">Order (packs)</th><th class="n">Whole packs</th><th class="n">Value</th><th>Bins</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr data-href={`/items/${l.itemId}`}><td>{l.stockCode}</td><td>{l.description}</td><td class="n">{l.packSize}</td>
              <td class={`n ${l.onHandUnits < 0 ? 'neg' : ''}`}>{+(l.onHandUnits / l.packSize).toFixed(3)}</td>
              <td class="n">{+(l.minUnits / l.packSize).toFixed(3)}</td><td class="n">{+(l.maxUnits / l.packSize).toFixed(3)}</td>
              <td class="n">{l.orderPacks}</td><td class="n"><b>{l.orderPacksWhole}</b></td><td class="n">{money(l.orderValue)}</td>
              <td>{l.bins.map((b) => <span class="chip">{b}</span>)}</td></tr>
          ))}</tbody>
        </table></div>
      </>
    ))
  })

  r.get('/minmax/suggest', async (c) => {
    const rows = await run(c, (tx) => suggestMinMax(tx))
    return page(c, 'Min/max from usage', (
      <>
        <h1>Min/max suggested from usage</h1>
        <p class="muted">Average daily usage over the last full months (set in Settings), times the min and max days. Levels set by hand or imported from Compharm are only replaced if you tick the box.</p>
        <form method="post" action="/reports/minmax/apply" class="row panel">
          <label class="row"><input type="checkbox" name="overwrite" /> Also replace levels set by hand or imported</label>
          <span class="spacer" /><button>Apply suggestions</button>
        </form>
        <div class="wrap"><table>
          <thead><tr><th>Code</th><th>Description</th><th class="n">Pack</th><th class="n">Sold (units)</th><th class="n">Units/day</th><th class="n">Now min/max</th><th class="n">Suggested</th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr data-href={`/items/${s.itemId}`}><td>{s.stockCode}</td><td>{s.description}</td><td class="n">{s.packSize}</td><td class="n">{s.soldUnits}</td>
              <td class="n">{s.aduUnits}</td>
              <td class="n">{s.currentMin === null ? '–' : `${+(s.currentMin / s.packSize).toFixed(2)} / ${+(s.currentMax! / s.packSize).toFixed(2)}`} <span class="muted">{s.currentSource ?? ''}</span></td>
              <td class="n">{qty(s.suggestedMin, s.packSize)} / {qty(s.suggestedMax, s.packSize)}</td></tr>
          ))}</tbody>
        </table></div>
      </>
    ))
  })

  r.post('/minmax/apply', async (c) => {
    requireRole(c, ['owner', 'pharmacist'])
    const b = await c.req.parseBody()
    const n = await run(c, (tx) => applyMinMaxSuggestions(tx, { overwrite: b.overwrite === 'on' }, c.get('user').userId))
    return back(c, '/reports/minmax/suggest', { ok: `Levels updated on ${n} items` })
  })

  r.get('/valuation', async (c) => {
    const v = await run(c, reports.stockValuation)
    return page(c, 'Stock value', (
      <>
        <h1>Stock value</h1>
        <div class="stats">
          <div class="stat"><b>{v.lines.toLocaleString()}</b><span>items in stock</span></div>
          <div class="stat"><b>{money(v.costValue)}</b><span>at average cost, excl VAT</span></div>
          <div class="stat"><b>{money(v.retailValue)}</b><span>at retail, incl VAT</span></div>
          <div class="stat"><b>{v.linesWithoutCost}</b><span>items in stock with no cost</span></div>
        </div>
      </>
    ))
  })

  const simple = (title: string, cols: string[], rows: any[], cells: (r: any) => any[], note?: string) =>
    <>
      <h1>{title}</h1>
      {note && <p class="muted">{note}</p>}
      <p class="muted">{rows.length} rows</p>
      <div class="wrap"><table>
        <thead><tr>{cols.map((h) => <th class={h.startsWith('#') ? 'n' : ''}>{h.replace(/^#/, '')}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr data-href={r.id ? `/items/${r.id}` : undefined}>{cells(r).map((v, i) => <td class={cols[i].startsWith('#') ? 'n' : ''}>{v}</td>)}</tr>)}</tbody>
      </table></div>
    </>

  r.get('/negative', async (c) => {
    const rows = await run(c, reports.negativeStock)
    return page(c, 'Negative stock', simple('Negative stock', ['Code', 'Description', '#On hand'], rows,
      (x) => [x.stock_code, x.description, qty(x.on_hand_units, x.pack_size)],
      'Usually stock sold or dispensed before the invoice was captured. Receive the invoice or count the item.'))
  })

  r.get('/dormant', async (c) => {
    const rows = await run(c, (tx) => reports.dormantStock(tx, 6))
    return page(c, 'Dormant stock', simple('Dormant stock', ['Code', 'Description', '#On hand', '#Value at cost'], rows,
      (x) => [x.stock_code, x.description, qty(x.on_hand_units, x.pack_size), money(num(x.cost_value))]))
  })

  r.get('/adjustments', async (c) => {
    const to = new Date()
    const from = new Date(to.getTime() - 30 * 86400_000)
    const rows = await run(c, (tx) => reports.adjustmentsReport(tx, from, new Date(to.getTime() + 60_000)))
    return page(c, 'Adjustments', simple('Adjustments, last 30 days', ['When', 'Code', 'Description', 'Type', '#Units', 'Reason', '#Value', 'By'], rows,
      (x) => [dateTime(x.occurred_at), x.stock_code, x.description, x.kind, x.qty_units, x.reason ?? x.reason_code ?? '', money(num(x.value)), x.user_name ?? '']))
  })

  r.get('/gp', async (c) => {
    const rows = await run(c, (tx) => reports.gpExceptions(tx, 10))
    return page(c, 'GP exceptions', simple('GP exceptions', ['Code', 'Description', '#Cost', '#Retail', '#GP excl VAT'], rows,
      (x) => [x.stock_code, x.description, money(num(x.cost_per_pack)), money(num(x.retail_per_pack)), `${x.gp_pct}%`],
      'Active items selling below cost or under 10% gross profit, with VAT taken off the price first.'))
  })

  r.get('/quarantine', async (c) => {
    const rows = await run(c, reports.quarantined)
    return page(c, 'Quarantined items', simple('Quarantined items', ['Code', 'Description', '#Cost', '#Retail', 'Why'], rows,
      (x) => [x.stock_code, x.description, x.cost_per_pack === null ? '' : money(num(x.cost_per_pack)), money(num(x.retail_per_pack)), x.status_reason],
      'These came in from Compharm with missing or impossible values. They stay searchable but cannot be sold until fixed and set to active.'))
  })

  r.get('/sales', async (c) => {
    const range = await rangeFrom(c)
    const d = await run(c, (tx) => dailySales(tx, range))
    if (c.req.query('format') === 'csv') {
      c.header('content-type', 'text/csv')
      c.header('content-disposition', `attachment; filename="daily-sales-${range.from}-${range.to}.csv"`)
      return c.body(csv([
        ['Date', 'Sales', 'Refunds', 'Total incl VAT', 'VAT', 'Excl VAT', 'Cost', 'GP', 'GP %'],
        ...d.rows.map((x) => [x.day, x.sales, x.refunds, x.total.toFixed(2), x.vat.toFixed(2), x.excl.toFixed(2), x.cost.toFixed(2), x.gp.toFixed(2), x.gpPct]),
      ]))
    }
    const t = d.totals
    return page(c, 'Daily sales', (
      <>
        <div class="row"><h1>Daily sales</h1><span class="spacer" /><a class="btn secondary" href={`?from=${range.from}&to=${range.to}&format=csv`}>Download CSV</a></div>
        <RangeForm {...range} />
        <div class="wrap"><table>
          <thead><tr><th>Date</th><th class="n">Sales</th><th class="n">Refunds</th><th class="n">Total incl VAT</th><th class="n">VAT</th><th class="n">Excl VAT</th><th class="n">Cost</th><th class="n">GP</th><th class="n">GP %</th></tr></thead>
          <tbody>{d.rows.map((x) => (
            <tr><td>{x.day}</td><td class="n">{x.sales}</td><td class="n">{x.refunds || ''}</td><td class="n">{money(x.total)}</td><td class="n">{money(x.vat)}</td>
              <td class="n">{money(x.excl)}</td><td class="n">{money(x.cost)}</td><td class="n">{money(x.gp)}</td><td class="n">{x.gpPct === null ? '' : `${x.gpPct.toFixed(1)}%`}</td></tr>
          ))}</tbody>
          <tfoot><tr><td><b>Total</b></td><td class="n">{t.sales}</td><td class="n">{t.refunds || ''}</td><td class="n"><b>{money(t.total)}</b></td><td class="n">{money(t.vat)}</td>
            <td class="n">{money(t.excl)}</td><td class="n">{money(t.cost)}</td><td class="n"><b>{money(t.gp)}</b></td><td class="n">{t.gpPct === null ? '' : `${t.gpPct.toFixed(1)}%`}</td></tr></tfoot>
        </table></div>
        <p class="hint">GP is on the price excluding VAT, at each item's average cost when it was sold.</p>
        <div class="blocks">
          <div class="block"><h3>By tender</h3><table class="sumtab">{d.byTender.map((x) => <tr><td>{tenderLabels[x.tender as Tender] ?? x.tender}</td><td class="n">{money(x.amount)}</td></tr>)}</table></div>
          <div class="block"><h3>By assistant</h3><table class="sumtab">{d.byAssistant.map((x) => <tr><td>{x.name} <span class="muted">({x.sales})</span></td><td class="n">{money(x.total)}</td></tr>)}</table></div>
        </div>
      </>
    ))
  })

  r.get('/sales-gp', async (c) => {
    const range = await rangeFrom(c)
    const rows = await run(c, (tx) => itemGp(tx, range))
    if (c.req.query('format') === 'csv') {
      c.header('content-type', 'text/csv')
      c.header('content-disposition', `attachment; filename="sales-gp-${range.from}-${range.to}.csv"`)
      return c.body(csv([
        ['Stock code', 'Description', 'Units', 'Packs', 'Total incl VAT', 'Excl VAT', 'Cost', 'GP', 'GP %', 'Discount given'],
        ...rows.map((x) => [x.stockCode, x.description, x.units, +(x.units / x.packSize).toFixed(3), x.total.toFixed(2), x.excl.toFixed(2), x.cost.toFixed(2), x.gp.toFixed(2), x.gpPct, x.discount.toFixed(2)]),
      ]))
    }
    const sum = rows.reduce((a, x) => ({ excl: a.excl + x.excl, gp: a.gp + x.gp, discount: a.discount + x.discount }), { excl: 0, gp: 0, discount: 0 })
    return page(c, 'Sales GP per item', (
      <>
        <div class="row"><h1>Sales GP per item</h1><span class="spacer" /><a class="btn secondary" href={`?from=${range.from}&to=${range.to}&format=csv`}>Download CSV</a></div>
        <RangeForm {...range} />
        <p class="muted">{rows.length} items sold for {money(sum.excl)} excl VAT, GP {money(sum.gp)}{sum.excl ? ` (${((sum.gp / sum.excl) * 100).toFixed(1)}%)` : ''}; {money(sum.discount)} given in price changes.</p>
        <div class="wrap"><table>
          <thead><tr><th>Code</th><th>Description</th><th class="n">Qty</th><th class="n">Excl VAT</th><th class="n">Cost</th><th class="n">GP</th><th class="n">GP %</th><th class="n">Discount</th></tr></thead>
          <tbody>{rows.map((x) => (
            <tr data-href={`/items/${x.itemId}`}><td>{x.stockCode}</td><td>{x.description}{x.missingCost && <span class="neg" title="No cost on record when sold"> no cost</span>}</td>
              <td class="n">{qty(x.units, x.packSize)}</td><td class="n">{money(x.excl)}</td><td class="n">{money(x.cost)}</td>
              <td class={`n ${x.gp < 0 ? 'neg' : ''}`}>{money(x.gp)}</td><td class="n">{x.gpPct === null ? '' : `${x.gpPct.toFixed(1)}%`}</td><td class="n">{x.discount ? money(x.discount) : ''}</td></tr>
          ))}</tbody>
        </table></div>
      </>
    ))
  })

  return r
}
