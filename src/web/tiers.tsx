import ExcelJS from 'exceljs'
import { Hono } from 'hono'
import { raw } from 'hono/html'
import { importedPeriods, type AbcSource } from '../domain/abc.js'
import { listBins } from '../domain/items.js'
import { stockTiers, weeklyOrder, type OrderLine, type Tier, type TierBasis, type TierGroup, type TierRow } from '../domain/tiers.js'
import { page, run, type Ctx, type Env } from './app.js'
import { download, formatHref, type Col } from './export.js'
import { money, pct, qty } from './layout.js'

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v)
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.min(hi, Math.max(lo, n)) : dflt
}
const packs = (r: TierRow) => Math.round((r.onHandUnits / r.packSize) * 1000) / 1000
const groupLabels: Record<TierGroup, string> = { all: 'All items', rx: 'Dispensary (schedule 1 and up)', otc: 'Over the counter (no schedule)' }

const style = raw(`<style>
.tier{display:inline-block;min-width:22px;text-align:center;border-radius:4px;font-weight:700;padding:1px 6px}.tier-A{background:#d9f2e3;color:#12643a}.tier-B{background:#fff1cc;color:#7a5600}.tier-C{background:#eceff3;color:#4b5563}.tier-x{color:#9aa1ab}
.flag{display:inline-block;border-radius:10px;padding:0 8px;font-size:12px;font-weight:600}.flag-out{background:#fde2e1;color:#a61b1b}.flag-negative{background:#a61b1b;color:#fff}.flag-low{background:#fff1cc;color:#7a5600}
.tier-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:12px 0}.tier-sum .stat{display:flex;flex-direction:column;gap:2px}.tier-sum b{font-size:20px}
.order-bar{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:18px;align-items:center}.order-bar b{font-size:18px}
#order td input[type=number]{width:64px}tr.off td{color:var(--muted)}tr.over .run{color:var(--bad);font-weight:700}
</style>`)

const Flag = ({ f }: { f: TierRow['flag'] }) =>
  f === 'out' ? <span class="flag flag-out">Out of stock</span>
  : f === 'negative' ? <span class="flag flag-negative">Negative</span>
  : f === 'low' ? <span class="flag flag-low">Low</span> : null
const TierChip = ({ t }: { t: Tier }) => <span class={`tier ${t === '-' ? 'tier-x' : `tier-${t}`}`}>{t === '-' ? '–' : t}</span>
const flagWord = (f: TierRow['flag']) => (f === 'out' ? 'Out of stock' : f === 'negative' ? 'Negative stock' : f === 'low' ? 'Low' : '')

const Tabs = ({ on, search }: { on: 'tiers' | 'order'; search: string }) => (
  <nav class="tabs noprint">
    <a href={`/reports/tiers${search}`} class={on === 'tiers' ? 'on' : ''}>Usage tiers</a>
    <a href={`/reports/tiers/order${search}`} class={on === 'order' ? 'on' : ''}>Weekly order</a>
  </nav>
)

/** The filters both screens share, read from the address and kept within sensible limits. */
async function load(c: Ctx) {
  const q = c.req.query()
  const basis: TierBasis = q.basis === 'sales' ? 'sales' : 'gp'
  const group: TierGroup = q.group === 'rx' || q.group === 'otc' ? q.group : 'all'
  const aShare = clamp(q.a, 50, 95, 80)
  const bShare = clamp(q.b, 1, 99 - aShare, Math.min(15, 99 - aShare))
  const days = Math.round(clamp(q.days, 7, 730, 90))
  const bin = (q.bin ?? '').trim().toUpperCase().slice(0, 40)
  const { result, periods, bins, source } = await run(c, async (tx) => {
    const [periods, bins] = await Promise.all([importedPeriods(tx), listBins(tx)])
    const opts = { basis, aShare, bShare, group, bin: bin || undefined }
    let source: AbcSource | null = q.source === 'live' ? { kind: 'live', days } : periods.find((p) => p.label === q.source) ? { kind: 'imported', label: q.source } : null
    let result = source ? await stockTiers(tx, { ...opts, source }) : null
    if (!source) {
      // First visit: the shop's own trading if there is any, otherwise the newest imported period.
      source = { kind: 'live', days }
      result = await stockTiers(tx, { ...opts, source })
      if (!result.total && periods.length) {
        source = { kind: 'imported', label: periods[0].label }
        result = await stockTiers(tx, { ...opts, source })
      }
    }
    return { result: result!, periods, bins, source }
  })
  // The filters as an address, for the tab links: always the source actually used.
  const keep = new URLSearchParams({ source: source.kind === 'live' ? 'live' : source.label, days: String(days), basis, group, a: String(aShare), b: String(bShare) })
  if (bin) keep.set('bin', bin)
  return { q, basis, group, aShare, bShare, days, bin, result, periods, bins, source, keep }
}

type Loaded = Awaited<ReturnType<typeof load>>

const Filters = ({ l, extra }: { l: Loaded; extra?: any }) => (
  <form class="row panel noprint" id="tier-filter">
    <label class="f">Sales from<select name="source">
      <option value="live" selected={l.source.kind === 'live'}>Our own trading</option>
      {l.periods.map((p) => <option value={p.label} selected={l.source.kind === 'imported' && l.source.label === p.label}>Imported {p.from} to {p.to}</option>)}
    </select></label>
    <label class="f" title="Used with our own trading">Trading days<input name="days" type="number" min="7" max="730" value={l.days} style="width:80px" /></label>
    <label class="f">Items<select name="group">
      {(Object.keys(groupLabels) as TierGroup[]).map((g) => <option value={g} selected={l.group === g}>{groupLabels[g]}</option>)}
    </select></label>
    <label class="f">Bin<select name="bin"><option value="">All bins</option>
      {l.bins.map((b) => <option value={b} selected={l.bin === b.toUpperCase()}>{b}</option>)}</select></label>
    <label class="f">Tier by<select name="basis"><option value="gp" selected={l.basis === 'gp'}>Profit</option><option value="sales" selected={l.basis === 'sales'}>Sales</option></select></label>
    <label class="f">A: first % of {l.basis === 'gp' ? 'profit' : 'sales'}<input name="a" type="number" min="50" max="95" value={l.aShare} style="width:70px" /></label>
    <label class="f">B: next %<input name="b" type="number" min="1" max="49" value={l.bShare} style="width:70px" /></label>
    {extra}
    <button class="secondary">Show</button>
  </form>
)

export function tierRoutes() {
  const r = new Hono<Env>()

  // ------------------------------------------------------------ usage tiers

  r.get('/', async (c) => {
    const l = await load(c)
    const { result } = l
    const tier = (['A', 'B', 'C', '-'] as const).find((k) => k === l.q.tier) ?? 'A'
    const problems = l.q.only === 'problems'
    const shown = result.rows.filter((x) => x.tier === tier && (!problems || x.flag === 'out' || x.flag === 'negative'))
    const href = (set: Record<string, string | null>) => {
      const p = new URLSearchParams(l.keep); p.set('tier', tier); if (problems) p.set('only', 'problems')
      for (const [k, v] of Object.entries(set)) v === null ? p.delete(k) : p.set(k, v)
      return `?${p}`
    }
    const word = l.basis === 'gp' ? 'profit' : 'sales'
    const cols: Col<TierRow>[] = [
      { h: 'Rank', v: (x) => x.rank }, { h: 'Tier', v: (x) => x.tier }, { h: 'Stock code', v: (x) => x.stockCode }, { h: 'Description', v: (x) => x.description },
      { h: 'Supplier', v: (x) => x.supplier }, { h: 'Bins', v: (x) => x.bins.join(' ') }, { h: 'Pack size', v: (x) => x.packSize, fmt: 'int' },
      { h: 'On hand (packs)', v: packs, fmt: 'qty' }, { h: 'Sold per month (packs)', v: (x) => x.perMonthPacks, fmt: 'qty' },
      { h: 'Days of cover', v: (x) => x.coverDays, fmt: 'int' }, { h: 'Stock flag', v: (x) => flagWord(x.flag) },
      { h: 'Sales excl VAT', v: (x) => Math.round(x.sales * 100) / 100, fmt: 'money' }, { h: 'GP', v: (x) => Math.round(x.gp * 100) / 100, fmt: 'money' },
      { h: 'Share %', v: (x) => Math.round(x.share * 100) / 100, fmt: 'pct' }, { h: 'Cumulative %', v: (x) => Math.round(x.cumulative * 100) / 100, fmt: 'pct' },
    ]
    // The download carries every tier, so one sheet has the whole picture; the screen shows one tier at a time.
    const dl = await download(c, `usage-tiers-${l.group}`, 'Usage tiers', cols, result.rows.filter((x) => x.tier !== '-'))
    if (dl) return dl
    const search = `?${l.keep}`
    return page(c, 'Usage tiers', (
      <>
        {style}
        <div class="row"><h1>Stock usage tiers</h1><span class="spacer" />
          <a class="btn secondary noprint" href={formatHref(c, 'xlsx')}>Download Excel</a>
          <a class="btn secondary noprint" href={formatHref(c, 'csv')}>Download CSV</a>
          <button class="secondary noprint" onclick="window.print()">Print</button></div>
        <Tabs on="tiers" search={search} />
        <Filters l={l} extra={<><input type="hidden" name="tier" value={tier} />{problems && <input type="hidden" name="only" value="problems" />}</>} />
        <p class="muted">{groupLabels[l.group]}{l.bin ? ` in bin ${l.bin}` : ''}, {result.period}. {word === 'profit' ? 'Gross profit' : 'Sales excl VAT'} {money(result.total)}.</p>
        <div class="tier-sum">
          {(['A', 'B', 'C'] as const).map((k) => (
            <a class="stat" href={href({ tier: k })} style={tier === k ? 'outline:2px solid var(--accent)' : ''}>
              <span><TierChip t={k} /> Tier {k}</span><b>{result.counts[k]} items</b>
              <span class="muted">{result.shares[k].toFixed(1)}% of {word}</span></a>
          ))}
          <a class="stat" href={href({ only: problems ? null : 'problems' })} style={problems ? 'outline:2px solid var(--accent)' : ''}>
            <span><span class="flag flag-out">Out of stock</span></span><b>{result.flags.out + result.flags.negative} selling items</b>
            <span class="muted">{result.flags.negative} of them negative · {result.flags.low} low</span></a>
        </div>
        <p class="hint">{tier === 'A' ? `Tier A: the ${result.counts.A} items that make the first ${l.aShare}% of ${word}. Never let these run out: count and order them every week.`
          : tier === 'B' ? `Tier B: the next ${l.bShare}% of ${word}. Keep a little stock and order as they run low.`
          : tier === 'C' ? `Tier C: the last ${100 - l.aShare - l.bShare}% of ${word}, and items that sold without profit. Keep stock lean; slow ones can be ordered per script.`
          : 'Items with no sales in this period.'}
          {' '}{problems ? <a href={href({ only: null })}>Show the whole tier.</a> : <a href={href({ only: 'problems' })}>Show only out of stock and negative.</a>}
          {tier !== '-' ? <> <a href={href({ tier: '-', only: null })}>{result.counts['-']} items had no sales.</a></> : null}</p>
        <div class="wrap"><table>
          <thead><tr><th class="n">#</th><th>Tier</th><th>Code</th><th>Description</th><th>Bins</th><th class="n">Pack</th><th class="n">On hand</th>
            <th class="n">Sold a month</th><th class="n">Days of cover</th><th>Stock</th><th class="n">Sales excl</th><th class="n">GP</th><th class="n">Share</th><th class="n">Cum.</th></tr></thead>
          <tbody>{shown.map((x) => (
            <tr data-href={`/items/${x.itemId}`} class={x.tier === '-' ? 'dim' : ''}>
              <td class="n">{x.rank ?? ''}</td><td><TierChip t={x.tier} /></td><td>{x.stockCode}</td>
              <td><a href={`/items/${x.itemId}`}>{x.description || <em class="muted">no description</em>}</a></td>
              <td>{x.bins.map((b) => <span class="chip">{b}</span>)}</td>
              <td class="n">{x.packSize}</td><td class={`n ${x.onHandUnits < 0 ? 'neg' : ''}`}>{qty(x.onHandUnits, x.packSize)}</td>
              <td class="n">{x.perMonthPacks ? +x.perMonthPacks.toFixed(1) : ''}</td><td class="n">{x.coverDays ?? ''}</td><td><Flag f={x.flag} /></td>
              <td class="n">{x.sales ? money(x.sales) : ''}</td><td class={`n ${x.gp < 0 ? 'neg' : ''}`}>{x.sales ? money(x.gp) : ''}</td>
              <td class="n">{x.rank ? pct(x.share) : ''}</td><td class="n">{x.rank ? pct(x.cumulative) : ''}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {!shown.length && <p class="muted">No items here.</p>}
        <p class="hint">Items are ranked by {word} over the period, best first. Tier A is the few items that together make the first {l.aShare}% of it, tier B the next {l.bShare}%, tier C the rest.
          "Sold a month" is the average over the period, in packs. "Days of cover" is how long the stock on hand lasts at that rate; under 7 days is flagged low.
          Own trading counts till sales and dispensed scripts (a script paid at the till is counted once). The Excel download has every tier.</p>
      </>
    ))
  })

  // ------------------------------------------------------------ weekly order within a budget

  r.get('/order', async (c) => {
    const l = await load(c)
    const budget = Math.round(clamp(l.q.budget, 0, 10_000_000, 3000) * 100) / 100
    const weeks = clamp(l.q.weeks, 0.5, 26, 2)
    const slowMonths = clamp(l.q.slow, 1, 24, 3)
    const tierSet = (l.q.tiers === 'A' || l.q.tiers === 'ABC' ? l.q.tiers : 'AB') as 'A' | 'AB' | 'ABC'
    // When the person has ticked lines and changed quantities, the form sends them back: keep those.
    let picks: { on: Set<string>; packs: Map<string, number> } | undefined
    if (l.q.picked === '1') {
      const on = new Set(c.req.queries('y') ?? [])
      const packMap = new Map<string, number>()
      for (const [k, v] of Object.entries(l.q)) if (k.startsWith('p_')) packMap.set(k.slice(2), clamp(v, 0, 100_000, 0))
      picks = { on, packs: packMap }
    }
    const order = weeklyOrder(l.result.rows, l.result.days, { budget, weeks, tiers: [...tierSet] as ('A' | 'B' | 'C')[], slowMonths }, picks)
    const monthly = (x: OrderLine) => Math.round(((x.row.gp / l.result.days) * 30.44) * 100) / 100

    if (l.q.format === 'xlsx') {
      c.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      c.header('content-disposition', `attachment; filename="weekly-order-${l.group}.xlsx"`)
      return c.body(await orderWorkbook(order.lines, { budget, weeks, period: l.result.period, group: groupLabels[l.group], monthly }))
    }
    const cols: Col<OrderLine>[] = [
      { h: 'Order? (Y/N)', v: (x) => (x.pick ? 'Y' : 'N') }, { h: 'Tier', v: (x) => x.row.tier }, { h: 'Stock code', v: (x) => x.row.stockCode },
      { h: 'Description', v: (x) => x.row.description }, { h: 'Supplier', v: (x) => x.row.supplier }, { h: 'Pack size', v: (x) => x.row.packSize, fmt: 'int' },
      { h: 'Stock now (packs)', v: (x) => packs(x.row), fmt: 'qty' }, { h: 'Sold per month (packs)', v: (x) => x.row.perMonthPacks, fmt: 'qty' },
      { h: 'Order packs', v: (x) => x.orderPacks, fmt: 'int' }, { h: 'Cost per pack', v: (x) => x.row.costPerPack, fmt: 'money' },
      { h: 'Line cost', v: (x) => x.lineCost, fmt: 'money' }, { h: 'Running total', v: (x) => x.runningTotal, fmt: 'money' },
      { h: 'Profit per month', v: monthly, fmt: 'money' }, { h: 'Note', v: (x) => x.note },
    ]
    const dl = await download(c, `weekly-order-${l.group}`, 'Weekly order', cols, order.lines)
    if (dl) return dl

    const search = `?${l.keep}`
    const keepOrder = new URLSearchParams(l.keep)
    keepOrder.set('budget', String(budget)); keepOrder.set('weeks', String(weeks)); keepOrder.set('tiers', tierSet); keepOrder.set('slow', String(slowMonths))
    const asideCount = order.lines.filter((x) => x.aside).length
    return page(c, 'Weekly order', (
      <>
        {style}
        <div class="row"><h1>Weekly order</h1><span class="spacer" />
          <button class="secondary noprint" onclick="window.print()">Print</button></div>
        <Tabs on="order" search={search} />
        <Filters l={l} extra={<>
          <label class="f">Budget (P)<input name="budget" type="number" min="0" step="any" value={budget} style="width:100px" /></label>
          <label class="f">Weeks of stock<input name="weeks" type="number" min="0.5" max="26" step="0.5" value={weeks} style="width:70px" /></label>
          <label class="f">Tiers<select name="tiers">
            <option value="A" selected={tierSet === 'A'}>A only</option><option value="AB" selected={tierSet === 'AB'}>A and B</option><option value="ABC" selected={tierSet === 'ABC'}>A, B and C</option></select></label>
          <label class="f">Per script if 1 pack lasts over (months)<input name="slow" type="number" min="1" max="24" value={slowMonths} style="width:70px" /></label>
        </>} />
        <p class="muted">{groupLabels[l.group]}{l.bin ? ` in bin ${l.bin}` : ''}, sales {l.result.period}. Every item in tier {{ A: 'A', AB: 'A or B', ABC: 'A, B or C' }[tierSet]} whose stock will not last {weeks} week{weeks === 1 ? '' : 's'},
          tier A first, then the most profit a month. Lines are ticked until the budget runs out.</p>
        <form method="get" id="order">
          {[...keepOrder.entries()].map(([k, v]) => <input type="hidden" name={k} value={v} />)}
          <input type="hidden" name="picked" value="1" />
          <div class="panel order-bar">
            <span>Budget <b>{money(budget)}</b></span>
            <span>Ticked <b id="spent">{money(order.spent)}</b></span>
            <span>Left <b id="left" class={budget - order.spent < 0 ? 'neg' : ''}>{money(budget - order.spent)}</b></span>
            <span><b id="lines">{order.picked}</b> of {order.lines.length} lines</span>
            <span class="spacer" />
            <button class="secondary noprint" name="format" value="xlsx">Download Excel</button>
            <button class="secondary noprint" name="format" value="csv">Download CSV</button>
            <button class="noprint">Keep my ticks</button>
          </div>
          <p class="hint noprint">Untick a line to leave it out, or change how many packs. The totals update as you go; "Download Excel" takes your ticks with it, and in Excel you can still change Y/N and packs.
            {order.overBudget ? ` ${order.overBudget} line${order.overBudget === 1 ? '' : 's'} did not fit the budget.` : ''}
            {asideCount ? ` ${asideCount} line${asideCount === 1 ? ' is' : 's are'} set aside (order per script, cost missing or selling below cost) and left unticked.` : ''}
            {picks ? <> <a href={`?${keepOrder}`}>Start again from the budget.</a></> : null}</p>
          <div class="wrap"><table>
            <thead><tr><th class="noprint">Order?</th><th>Tier</th><th>Code</th><th>Description</th><th>Supplier</th><th class="n">Pack</th><th class="n">Stock now</th>
              <th class="n">Sold a month</th><th class="n">Order packs</th><th class="n">Cost a pack</th><th class="n">Line cost</th><th class="n">Running total</th><th class="n">Profit a month</th><th>Note</th></tr></thead>
            <tbody>{order.lines.map((x) => (
              <tr class={`${x.pick ? '' : 'off'} ${x.pick && x.runningTotal > budget ? 'over' : ''}`} data-cost={x.row.costPerPack ?? 0}>
                <td class="noprint"><input type="checkbox" name="y" value={x.row.itemId} checked={x.pick} aria-label={`Order ${x.row.description}`} /></td>
                <td><TierChip t={x.row.tier} /></td><td>{x.row.stockCode}</td>
                <td><a href={`/items/${x.row.itemId}`}>{x.row.description}</a></td><td>{x.row.supplier ?? ''}</td>
                <td class="n">{x.row.packSize}</td><td class={`n ${x.row.onHandUnits < 0 ? 'neg' : ''}`}>{qty(x.row.onHandUnits, x.row.packSize)}</td>
                <td class="n">{+x.row.perMonthPacks.toFixed(1)}</td>
                <td class="n"><input type="number" name={`p_${x.row.itemId}`} min="0" step="1" value={x.orderPacks} /></td>
                <td class="n">{money(x.row.costPerPack)}</td><td class="n line">{money(x.lineCost)}</td><td class="n run">{x.pick ? money(x.runningTotal) : ''}</td>
                <td class="n">{money(monthly(x))}</td><td>{x.note}</td>
              </tr>
            ))}</tbody>
          </table></div>
          {!order.lines.length && <p class="muted">Nothing to order: every item in these tiers has enough stock for {weeks} week{weeks === 1 ? '' : 's'}.</p>}
        </form>
        <p class="hint">Order packs = enough for {weeks} week{weeks === 1 ? '' : 's'} at the average rate, less what is on the shelf, rounded up to whole packs. Negative stock counts as none and is noted so it can be counted.
          An item where one pack lasts more than {slowMonths} months is set aside to order per script. Cost per pack is the last cost excl VAT.</p>
        <script>{raw(orderScript(budget))}</script>
      </>
    ))
  })

  return r
}

/** Recount the totals on the order screen as lines are ticked and packs changed. */
const orderScript = (budget: number) => `
(() => {
  const f = document.getElementById('order'); if (!f) return
  const fmt = (n) => (n < 0 ? '-' : '') + 'P' + Math.abs(n).toLocaleString('en-BW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const recount = () => {
    let run = 0, lines = 0
    f.querySelectorAll('tbody tr').forEach((tr) => {
      const on = tr.querySelector('input[type=checkbox]').checked
      const n = Math.max(0, Math.floor(Number(tr.querySelector('input[type=number]').value) || 0))
      const cost = Math.round(n * Number(tr.dataset.cost) * 100) / 100
      tr.querySelector('.line').textContent = fmt(cost)
      if (on && n > 0) { run = Math.round((run + cost) * 100) / 100; lines++ }
      tr.querySelector('.run').textContent = on && n > 0 ? fmt(run) : ''
      tr.classList.toggle('off', !(on && n > 0))
      tr.classList.toggle('over', on && n > 0 && run > ${budget} + 1e-9)
    })
    document.getElementById('spent').textContent = fmt(run)
    const left = document.getElementById('left'); left.textContent = fmt(${budget} - run); left.classList.toggle('neg', ${budget} - run < 0)
    document.getElementById('lines').textContent = lines
  }
  f.addEventListener('input', recount); f.addEventListener('change', recount)
})()`

/**
 * The order as a workbook that still works on its own: type N in "Order?" or change the packs, and the
 * line cost, running total, spent and money left update, like the order sheets the shop already uses.
 */
async function orderWorkbook(lines: OrderLine[], o: { budget: number; weeks: number; period: string; group: string; monthly: (x: OrderLine) => number }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'sylken'
  const ws = wb.addWorksheet('Weekly order', { views: [{ state: 'frozen', ySplit: 5 }] })
  const first = 6
  const last = Math.max(first, first + lines.length - 1)
  const spent = lines.filter((x) => x.pick).reduce((n, x) => n + x.lineCost, 0)
  ws.getCell('A1').value = `Weekly order: ${o.weeks} week${o.weeks === 1 ? '' : 's'} of stock, ${o.group}`
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.getCell('A2').value = `Sales ${o.period}. Type N in "Order?" to leave a line out, or change "Order packs". Totals update by themselves.`
  ws.getCell('A3').value = 'Budget (P):'; ws.getCell('C3').value = o.budget
  ws.getCell('E3').value = 'Spent:'; ws.getCell('F3').value = { formula: `SUM(N${first}:N${last})`, result: spent }
  ws.getCell('H3').value = 'Left:'; ws.getCell('I3').value = { formula: `C3-F3`, result: o.budget - spent }
  ws.getCell('K3').value = 'Lines ticked:'; ws.getCell('L3').value = { formula: `COUNTIF(B${first}:B${last},"Y")`, result: lines.filter((x) => x.pick).length }
  for (const a of ['A3', 'E3', 'H3', 'K3']) ws.getCell(a).font = { bold: true }
  for (const a of ['C3', 'F3', 'I3']) ws.getCell(a).numFmt = '#,##0.00'
  const heads = ['Rank', 'Order? (Y/N)', 'Tier', 'Stock code', 'Description', 'Supplier', 'Bin', 'Pack size', 'Stock now (packs)', 'Sold per month (packs)',
    'Days of cover', 'Order packs', 'Cost per pack (P)', 'Line cost (P)', 'Running total (P)', 'Within budget?', 'Profit per month (P)', 'Note']
  const widths = [6, 12, 6, 16, 36, 16, 12, 9, 12, 14, 10, 11, 13, 12, 14, 13, 14, 44]
  ws.getRow(5).values = heads
  ws.getRow(5).font = { bold: true }
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w })
  let run = 0
  lines.forEach((x, i) => {
    const n = first + i
    if (x.pick) run += x.lineCost
    ws.getRow(n).values = [
      i + 1, x.pick ? 'Y' : 'N', x.row.tier, x.row.stockCode, x.row.description, x.row.supplier ?? '', x.row.bins[0] ?? '', x.row.packSize,
      packs(x.row), x.row.perMonthPacks, x.row.coverDays ?? '', x.orderPacks, x.row.costPerPack ?? 0,
      { formula: `IF(UPPER(B${n})="Y",L${n}*M${n},0)`, result: x.pick ? x.lineCost : 0 } as any,
      { formula: `SUM($N$${first}:N${n})`, result: Math.round(run * 100) / 100 } as any,
      { formula: `IF(UPPER(B${n})="Y",IF(O${n}<=$C$3,"Yes","OVER"),"left out")`, result: x.pick ? (run <= o.budget + 1e-9 ? 'Yes' : 'OVER') : 'left out' } as any,
      o.monthly(x), x.note,
    ]
  })
  for (const col of [13, 14, 15, 17]) ws.getColumn(col).numFmt = '#,##0.00'
  for (const col of [9, 10]) ws.getColumn(col).numFmt = '0.###'
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: heads.length } }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}
