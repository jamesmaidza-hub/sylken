import { Hono } from 'hono'
import { raw } from 'hono/html'
import { num } from '../db/index.js'
import { abcRanking, importedPeriods, slotSuggestions, SLOTTING, type AbcBasis, type AbcRow, type AbcSource, type SlotMove } from '../domain/abc.js'
import { DomainError } from '../domain/errors.js'
import { createItem, getItem, itemMargins, itemsByBin, listBins, moveItemsToBin, priceFor, searchItems, updateItem, type ItemInput } from '../domain/items.js'
import { setMinMax } from '../domain/minmax.js'
import { itemMovements } from '../domain/reports.js'
import { getSettings } from '../domain/settings.js'
import { adjustStock } from '../domain/stock.js'
import { packsToUnits } from '../domain/units.js'
import { back, can, page, run, type Env } from './app.js'
import { download, formatHref, type Col } from './export.js'
import { dateTime, money, pct, qty, StatusChip } from './layout.js'

/** The three ways of looking at the item list: search, by bin, and ABC. */
const ItemTabs = ({ on }: { on: 'list' | 'bins' | 'abc' }) => (
  <nav class="tabs noprint">
    <a href="/items" class={on === 'list' ? 'on' : ''}>List</a>
    <a href="/items/bins" class={on === 'bins' ? 'on' : ''}>Bins</a>
    <a href="/items/abc" class={on === 'abc' ? 'on' : ''}>ABC</a>
  </nav>
)

/** Link to an item that keeps the search it was found by, so the results stay on screen above it. */
const itemHref = (id: string, q: string, status?: string) =>
  `/items/${id}${q ? `?q=${encodeURIComponent(q)}${status ? `&status=${encodeURIComponent(status)}` : ''}` : ''}`

// Tabs on the item record; the open tab is kept in the address so Save and refresh come back to it.
const tabs = `
(() => {
  const nav = document.getElementById('item-tabs'); if (!nav) return
  const show = (t) => {
    if (!nav.querySelector('[data-tab="' + t + '"]')) t = 'general'
    nav.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.tab === t))
    document.querySelectorAll('section.tab').forEach((s) => { s.hidden = s.dataset.tab !== t })
    document.querySelectorAll('form[method=post]').forEach((f) => { f.action = f.action.split('#')[0] + '#' + t })
  }
  nav.addEventListener('click', (e) => { const a = e.target.closest('a'); if (!a) return; e.preventDefault(); history.replaceState(null, '', '#' + a.dataset.tab); show(a.dataset.tab) })
  show(location.hash.slice(1))
})()`

// Items by bin: change the filter at once, fold bins, tick items to move, print with every bin open.
const binsScript = `
(() => {
  const f = document.getElementById('bins-filter')
  f.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => f.submit()))
  const all = () => document.querySelectorAll('details.bin-group')
  document.getElementById('bins-close').onclick = () => all().forEach((d) => { d.open = false })
  document.getElementById('bins-print').onclick = () => window.print()
  // one bin open at a time: opening a bin closes the others (printing opens them all for the count sheet)
  let printing = false
  all().forEach((d) => d.addEventListener('toggle', () => {
    if (printing || !d.open) return
    all().forEach((o) => { if (o !== d && o.open) o.open = false })
  }))
  let was = []
  addEventListener('beforeprint', () => { printing = true; was = [...all()].map((d) => d.open); all().forEach((d) => { d.open = true }) })
  addEventListener('afterprint', () => { all().forEach((d, i) => { d.open = was[i] ?? d.open }); setTimeout(() => { printing = false }, 500) })
  const mf = document.getElementById('move-form'); if (!mf) return
  const count = () => {
    const n = document.querySelectorAll('input[name=move]:checked').length
    document.getElementById('move-count').textContent = n ? n + ' item' + (n === 1 ? '' : 's') + ' ticked' : 'Tick items to move them'
    document.getElementById('move-go').disabled = !n
  }
  document.addEventListener('change', (e) => {
    const t = e.target
    if (t.classList && t.classList.contains('tick-all')) t.closest('table').querySelectorAll('input[name=move]').forEach((x) => { x.checked = t.checked })
    if (t.name === 'move' || (t.classList && t.classList.contains('tick-all'))) count()
  })
  mf.addEventListener('submit', (e) => {
    const n = document.querySelectorAll('input[name=move]:checked').length
    if (!confirm('Move ' + n + ' item' + (n === 1 ? '' : 's') + ' to bin ' + mf.to.value.trim().toUpperCase() + '?')) e.preventDefault()
  })
})()`

const optNum = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(v))

function parseItemForm(b: Record<string, unknown>): Partial<ItemInput> {
  return {
    stockCode: String(b.stockCode ?? ''),
    description: String(b.description ?? ''),
    packSize: Number(b.packSize || 1),
    sellLoose: b.sellLoose === 'on',
    costPerPack: optNum(b.costPerPack),
    retailPerPack: optNum(b.retailPerPack),
    markupOverride: optNum(b.markupPct) === null ? null : optNum(b.markupPct)! / 100,
    vatRate: optNum(b.vatPct) === null ? null : optNum(b.vatPct)! / 100,
    schedule: optNum(b.schedule),
    nappiCode: String(b.nappiCode ?? '').trim() || null,
    status: (b.status as any) || undefined,
    barcodes: String(b.barcodes ?? '').split(/[\s,]+/).filter(Boolean),
    bins: String(b.bins ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}

export function itemRoutes() {
  const r = new Hono<Env>()

  r.get('/', async (c) => {
    const q = c.req.query('q') ?? ''
    const status = c.req.query('status') || undefined
    const offset = Number(c.req.query('offset') ?? 0)
    const items = await run(c, (tx) => searchItems(tx, q, { status, includeDormant: true, limit: 100, offset }))
    // A single exact barcode hit goes straight to the item, like a scan should.
    if (q && items.length === 1 && (items[0].stockCode === q.trim() || items[0].barcodes.includes(q.trim()) || items[0].nappiCode === q.trim())) {
      return c.redirect(`/items/${items[0].id}`)
    }
    return page(c, 'Items', (
      <>
        <div class="row"><h1>Items</h1><span class="spacer" /><a class="btn" href="/items/new">New item</a></div>
        <ItemTabs on="list" />
        <form class="row panel">
          <input name="q" value={q} data-search placeholder="Scan a barcode, or type words from the description  ( / )" style="flex:1" autofocus />
          <select name="status">
            <option value="">Active and quarantined</option>
            {['active', 'dormant', 'quarantined', 'discontinued'].map((s) => <option value={s} selected={s === status}>{s}</option>)}
          </select>
          <button>Search</button>
        </form>
        <p class="hint">↑ ↓ to move, Enter to open. Dormant items are the Compharm catalogue with no recent stock or sales; they appear when searched by name.</p>
        <div class="wrap"><table>
          <thead><tr><th>Code</th><th>Description</th><th class="n">Pack</th><th class="n">On hand</th><th class="n">Cost</th><th class="n">Retail</th><th>Bins</th><th>Status</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr data-href={itemHref(i.id, q, status)} class={i.status === 'dormant' ? 'dim' : ''}>
                <td>{i.stockCode}</td><td><a href={itemHref(i.id, q, status)}>{i.description || <em class="muted">no description</em>}</a></td>
                <td class="n">{i.packSize}</td><td class={`n ${i.onHandUnits < 0 ? 'neg' : ''}`}>{qty(i.onHandUnits, i.packSize)}</td>
                <td class="n">{money(i.costPerPack)}</td><td class="n">{money(i.retailPerPack)}</td>
                <td>{i.bins.map((b) => <span class="chip">{b}</span>)}</td><td><StatusChip status={i.status} reason={i.statusReason} /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {items.length === 100 && <p><a href={`/items?q=${encodeURIComponent(q)}&status=${status ?? ''}&offset=${offset + 100}`}>Next 100</a></p>}
        {!items.length && <p class="muted">Nothing found.</p>}
      </>
    ))
  })

  const general = (i: any) => (
    <div class="grid">
      <label>Stock code<input name="stockCode" value={i?.stockCode ?? ''} required /></label>
      <label style="grid-column:span 2">Description<input name="description" value={i?.description ?? ''} required /></label>
      <label>Pack size (units per pack)<input name="packSize" type="number" min="1" step="1" value={i?.packSize ?? 1} /></label>
      <label>Schedule<input name="schedule" type="number" min="0" step="1" value={i?.schedule ?? ''} /></label>
      <label>NAPPI code (for medical aid claims)<input name="nappiCode" inputmode="numeric" value={i?.nappiCode ?? ''} placeholder="e.g. 708001-001" /></label>
      <label>Barcodes (space separated)<input name="barcodes" value={i?.barcodes?.join(' ') ?? ''} /></label>
      <label>Bins (comma separated)<input name="bins" value={i?.bins?.join(', ') ?? ''} /></label>
      {i && (
        <label>Status<select name="status">
          {['active', 'dormant', 'quarantined', 'discontinued'].map((s) => <option value={s} selected={s === i.status}>{s}</option>)}
        </select></label>
      )}
      <label class="row" style="flex-direction:row"><input type="checkbox" name="sellLoose" checked={i?.sellLoose} /> Can sell loose units</label>
    </div>
  )
  const pricing = (i: any, settings: any) => (
    <div class="grid">
      <label>Cost per pack, excl VAT<input name="costPerPack" type="number" step="0.0001" min="0" value={i?.costPerPack ?? ''} /></label>
      <label>Retail per pack, incl VAT<input name="retailPerPack" type="number" step="0.01" min="0" value={i?.retailPerPack ?? ''} placeholder="blank = from markup" /></label>
      <label>Markup % (blank = {(settings.defaultMarkup * 100).toFixed(0)}%)<input name="markupPct" type="number" step="0.01" value={i?.markupOverride != null ? (i.markupOverride * 100).toFixed(2) : ''} /></label>
      <label>VAT % (blank = {(settings.vatRate * 100).toFixed(0)}%)<input name="vatPct" type="number" step="0.01" value={i?.vatRate != null ? (i.vatRate * 100).toFixed(2) : ''} /></label>
    </div>
  )

  r.get('/bins', async (c) => {
    const bin = c.req.query('bin') || ''
    const status = c.req.query('status') || undefined
    const open = c.req.query('open') ?? ''
    const { groups, bins, tz } = await run(c, async (tx) => ({ groups: await itemsByBin(tx, { bin, status }), bins: await listBins(tx), tz: (await getSettings(tx)).timezone }))
    const count = groups.reduce((n, g) => n + g.items.length, 0)
    const shelves = groups.filter((g) => g.bin).length
    const mover = can(c, 'stock.adjust')
    const back = `/items/bins?bin=${encodeURIComponent(bin)}&status=${encodeURIComponent(status ?? '')}`
    return page(c, 'Items by bin', (
      <>
        <div class="row"><h1>Items</h1><span class="spacer" />
          <button type="button" class="secondary noprint" id="bins-close">Close bin</button>
          <button type="button" class="noprint" id="bins-print">🖨 Print list</button></div>
        <ItemTabs on="bins" />
        <form class="row panel noprint" id="bins-filter">
          <label class="f">Bin<select name="bin">
            <option value="">All bins</option>
            {bins.map((b) => <option value={b} selected={b === bin.toUpperCase()}>{b}</option>)}
            <option value="-" selected={bin === '-'}>No bin yet</option>
          </select></label>
          <label class="f">Status<select name="status">
            <option value="">Active and quarantined</option>
            {['active', 'dormant', 'quarantined', 'discontinued'].map((s) => <option value={s} selected={s === status}>{s}</option>)}
          </select></label>
          <button class="secondary">Show</button>
          <span class="spacer" /><span class="muted">{count} item{count === 1 ? '' : 's'} on {shelves} bin{shelves === 1 ? '' : 's'}</span>
        </form>
        {mover && <form method="post" action="/items/bins/move" class="row panel noprint move-bar" id="move-form">
          <input type="hidden" name="back" value={back} />
          <b id="move-count">Tick items to move them</b>
          <label class="row" style="gap:6px">to bin<input name="to" list="bin-names" required autocomplete="off" placeholder="e.g. A12" style="width:140px;text-transform:uppercase" /></label>
          <datalist id="bin-names">{bins.map((b) => <option value={b} />)}</datalist>
          <button id="move-go" disabled>Move</button>
          <span class="hint">Only the shelf changes. Stock on hand stays the same.</span>
        </form>}
        <p class="print-only">Printed {new Date().toLocaleString('en-GB', { timeZone: tz })}. Count each item and write the number in the Counted column.</p>
        {groups.map((g) => (
          <details class="bin-group" open={!!bin || open === (g.bin ?? '-')} data-bin={g.bin ?? '-'}>
            <summary><span class="bin-name">{g.bin ? <>Bin {g.bin}</> : 'No bin yet'}</span> <span class="muted">{g.items.length} item{g.items.length === 1 ? '' : 's'}</span></summary>
            <div class="wrap"><table>
              <thead><tr>{mover && <th class="noprint"><input type="checkbox" class="tick-all" title="Tick every item in this bin" /></th>}
                <th>Code</th><th>Description</th><th class="n">Pack</th><th class="n">On hand</th><th class="n noprint">Retail</th><th class="noprint">Status</th><th class="print-only counted">Counted</th></tr></thead>
              <tbody>{g.items.map((i) => (
                <tr data-href={`/items/${i.id}`}>
                  {mover && <td class="noprint"><input type="checkbox" name="move" form="move-form" value={`${g.bin ?? '-'}|${i.id}`} /></td>}
                  <td>{i.stockCode}</td><td><a href={`/items/${i.id}`}>{i.description}</a>{i.bins.length > 1 && <span class="hint"> also in {i.bins.filter((b) => b !== g.bin).join(', ')}</span>}</td>
                  <td class="n">{i.packSize}</td><td class={`n ${i.onHandUnits < 0 ? 'neg' : ''}`}>{qty(i.onHandUnits, i.packSize)}</td>
                  <td class="n noprint">{money(i.retailPerPack)}</td><td class="noprint"><StatusChip status={i.status} reason={i.statusReason} /></td>
                  <td class="print-only counted" />
                </tr>
              ))}</tbody>
            </table></div>
          </details>
        ))}
        {!groups.length && <p class="muted">No items here.</p>}
        <p class="hint noprint">Click a bin to open it. A bin is also set on the item's General tab (Bins, comma separated). An item kept on two shelves shows under both.</p>
        <script>{raw(binsScript)}</script>
      </>
    ))
  })

  r.post('/bins/move', async (c) => {
    const b = await c.req.parseBody({ all: true })
    const picked = ([] as unknown[]).concat(b.move ?? []).map(String)
    if (!picked.length) throw new DomainError('tick the items to move first')
    const moves = picked.map((v) => {
      const [from, itemId] = v.split('|')
      return { from: from === '-' ? null : from, itemId }
    })
    const to = String(b.to ?? '')
    const n = await run(c, (tx) => moveItemsToBin(tx, moves, to, c.get('user').userId))
    const target = to.trim().toUpperCase()
    const backTo = new URL(/^\/items\/(bins|abc\/moves)/.test(String(b.back ?? '')) ? String(b.back) : '/items/bins', 'http://x')
    for (const k of ['open', 'ok', 'err']) backTo.searchParams.delete(k)
    if (backTo.pathname === '/items/bins') backTo.searchParams.set('open', target)
    return back(c, `${backTo.pathname}${backTo.search}`, { ok: `Moved ${n} item${n === 1 ? '' : 's'} to bin ${target}` })
  })

  /** The ABC filter from the address, and the ranking it asks for. */
  const loadAbc = async (c: Parameters<typeof run>[0]) => {
    const q = c.req.query()
    const basis: AbcBasis = q.basis === 'gp' ? 'gp' : 'sales'
    // 20/30/50: the top 20% of items are A, the next 30% B, the remaining 50% C. aPct and bPct are cumulative cut-offs.
    const aItems = Math.min(98, Math.max(1, Number(q.a) || 20))
    const bItems = Math.min(99 - aItems, Math.max(1, Number(q.b) || 30))
    const aPct = aItems
    const bPct = aItems + bItems
    const days = Math.min(730, Math.max(7, Math.round(Number(q.days) || 90)))
    const { result, periods, source } = await run(c, async (tx) => {
      const periods = await importedPeriods(tx)
      const pick = (s: string | undefined): AbcSource | null =>
        s === 'live' ? { kind: 'live', days } : periods.find((p) => p.label === s) ? { kind: 'imported', label: s! } : null
      let source = pick(q.source)
      let result = source ? await abcRanking(tx, { source, basis, aPct, bPct }) : null
      if (!source) {
        // First visit: the shop's own trading if there is any, otherwise the newest imported period.
        source = { kind: 'live', days }
        result = await abcRanking(tx, { source, basis, aPct, bPct })
        if (!result.total && periods.length) {
          source = { kind: 'imported', label: periods[0].label }
          result = await abcRanking(tx, { source, basis, aPct, bPct })
        }
      }
      return { result: result!, periods, source }
    })
    return { q, basis, aPct, bPct, aItems, bItems, days, result, periods, source }
  }

  r.get('/abc/moves', async (c) => {
    const { basis, result, aItems, bItems } = await loadAbc(c)
    const s = slotSuggestions(result.rows)
    const mover = can(c, 'stock.adjust')
    const here = `/items/abc/moves${new URL(c.req.url).search}`
    const abcHref = `/items/abc${new URL(c.req.url).search}`
    const total = [...s.forward.values()].reduce((n, l) => n + l.length, 0) + s.back.length
    const table = (list: SlotMove[], formId: string) => (
      <div class="wrap"><table>
        <thead><tr>{mover && <th class="noprint"><input type="checkbox" class="tick-all" title="Tick all" checked /></th>}
          <th>Code</th><th>Description</th><th>Now in</th><th>Why</th><th class="n">Sales excl</th></tr></thead>
        <tbody>{list.map((m) => (
          <tr data-href={`/items/${m.itemId}`}>
            {mover && <td class="noprint"><input type="checkbox" name="move" form={formId} value={`${m.from ?? '-'}|${m.itemId}`} checked /></td>}
            <td>{m.row.stockCode}</td><td><a href={`/items/${m.itemId}`}>{m.row.description}</a></td>
            <td>{m.row.bins.length ? m.row.bins.map((b) => <span class="chip">{b}</span>) : <em class="muted">no bin</em>}</td>
            <td>{m.reason}</td><td class="n">{money(m.row.sales)}</td>
          </tr>
        ))}</tbody>
      </table></div>
    )
    return page(c, 'Suggested bin moves', (
      <>
        <div class="row"><h1>Items</h1><span class="spacer" /><a class="btn noprint" href="/items/new">New item</a></div>
        <ItemTabs on="abc" />
        <div class="row"><h2 style="margin:12px 0">Suggested bin moves</h2><span class="spacer" /><a class="btn secondary noprint" href={abcHref}>Back to ABC list</a></div>
        <p class="muted">From the ABC ranking ({result.period}, by {basis === 'gp' ? 'gross profit' : 'sales value'}): split {aItems}/{bItems}/{100 - aItems - bItems} by item count: class A belongs in {SLOTTING.A}, class B in {SLOTTING.B}, and class C should not
          take up either. {s.ok} ranked items are already right and {s.locked} sit in a bin that is never moved ({SLOTTING.locked.join(', ')}). Nothing moves until you press the button; only the shelf changes, stock on hand stays the same.</p>
        {total === 0 && <p class="panel">Nothing to move: every ranked item is already on the right shelf.</p>}
        {[...s.forward.entries()].map(([to, list], n) => (
          <details class="bin-group" open>
            <summary><span class="bin-name">Move to {to}</span> <span class="muted">{list.length} item{list.length === 1 ? '' : 's'}</span></summary>
            {mover && <form method="post" action="/items/bins/move" class="row panel noprint move-bar" id={`slot-${n}`}>
              <input type="hidden" name="back" value={here} /><input type="hidden" name="to" value={to} />
              <b>Untick any you do not want to move</b><button>Move ticked to {to}</button></form>}
            {table(list, `slot-${n}`)}
          </details>
        ))}
        {s.back.length > 0 && (
          <details class="bin-group" open>
            <summary><span class="bin-name">Move out of {SLOTTING.A} / {SLOTTING.B}</span> <span class="muted">{s.back.length} class C item{s.back.length === 1 ? '' : 's'}</span></summary>
            {mover && <form method="post" action="/items/bins/move" class="row panel noprint move-bar" id="slot-back">
              <input type="hidden" name="back" value={here} />
              <label class="row" style="gap:6px">to bin<input name="to" list="bin-names" required autocomplete="off" placeholder="e.g. TABLETSA" style="width:160px;text-transform:uppercase" /></label>
              <button>Move ticked</button><span class="hint">Pick the back shelf for these slow sellers.</span></form>}
            {table(s.back, 'slot-back')}
          </details>
        )}
        <script>{raw(`document.addEventListener('change',function(e){var t=e.target;if(t.classList&&t.classList.contains('tick-all'))t.closest('table').querySelectorAll('input[name=move]').forEach(function(x){x.checked=t.checked})})`)}</script>
      </>
    ))
  })

  r.get('/abc', async (c) => {
    const { q, basis, aItems, bItems, days, result, periods, source } = await loadAbc(c)
    const cls = (['A', 'B', 'C', '-'] as const).find((k) => k === q.cls) ?? 'A'
    const shown = result.rows.filter((r) => r.cls === cls)
    const classHref = (k: string) => { const p = new URLSearchParams(new URL(c.req.url).search); p.delete('format'); p.set('cls', k); return `?${p}` }
    const cols: Col<AbcRow>[] = [
      { h: 'Rank', v: (r) => r.rank }, { h: 'Class', v: (r) => r.cls }, { h: 'Stock code', v: (r) => r.stockCode }, { h: 'Description', v: (r) => r.description },
      { h: 'Pack size', v: (r) => r.packSize, fmt: 'int' }, { h: 'On hand (packs)', v: (r) => Math.round((r.onHandUnits / r.packSize) * 1000) / 1000, fmt: 'qty' },
      { h: 'Sold (packs)', v: (r) => Math.round((r.qtyUnits / r.packSize) * 1000) / 1000, fmt: 'qty' }, { h: 'Sales excl VAT', v: (r) => Math.round(r.sales * 100) / 100, fmt: 'money' },
      { h: 'Cost', v: (r) => Math.round(r.cost * 100) / 100, fmt: 'money' }, { h: 'GP', v: (r) => Math.round(r.gp * 100) / 100, fmt: 'money' },
      { h: 'Share %', v: (r) => Math.round(r.share * 100) / 100, fmt: 'pct' }, { h: 'Cumulative %', v: (r) => Math.round(r.cumulative * 100) / 100, fmt: 'pct' },
      { h: 'Bins', v: (r) => r.bins.join(' ') },
    ]
    const file = await download(c, `abc-${basis}`, 'ABC list', cols, shown)
    if (file) return file
    const sourceValue = source.kind === 'live' ? 'live' : source.label
    const basisWord = basis === 'gp' ? 'gross profit' : 'sales value (excl VAT)'
    const mover = can(c, 'stock.adjust')
    return page(c, 'ABC list', (
      <>
        <div class="row"><h1>Items</h1><span class="spacer" />
          <a class="btn secondary noprint" href={`/items/abc/moves${new URL(c.req.url).search}`}>Suggested bin moves</a>
          <a class="btn secondary noprint" href={formatHref(c, 'xlsx')}>Download Excel</a><a class="btn secondary noprint" href={formatHref(c, 'csv')}>Download CSV</a>
          <a class="btn noprint" href="/items/new">New item</a></div>
        <ItemTabs on="abc" />
        <style>{raw('.abc-cls{display:inline-block;min-width:22px;text-align:center;border-radius:4px;font-weight:700;padding:1px 6px}.abc-A{background:#d9f2e3;color:#12643a}.abc-B{background:#fff1cc;color:#7a5600}.abc-C{background:#eceff3;color:#4b5563}.abc-x{color:#9aa1ab}.abc-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:12px 0}.abc-sum .panel{margin:0}.abc-sum b{font-size:20px}')}</style>
        <form class="row panel noprint" id="abc-filter">
          <label class="f">Rank by<select name="basis"><option value="sales" selected={basis === 'sales'}>Sales value</option><option value="gp" selected={basis === 'gp'}>Gross profit</option></select></label>
          <label class="f">Sales from<select name="source">
            <option value="live" selected={source.kind === 'live'}>Our own trading</option>
            {periods.map((p) => <option value={p.label} selected={source.kind === 'imported' && source.label === p.label}>Imported {p.from} to {p.to} ({p.items} items)</option>)}
          </select></label>
          <label class="f">Trading days<input name="days" type="number" min="7" max="730" value={days} style="width:80px" /></label>
          <label class="f">A: top % of items<input name="a" type="number" min="1" max="98" value={aItems} style="width:70px" /></label>
          <label class="f">B: next % of items<input name="b" type="number" min="1" max="98" value={bItems} style="width:70px" /></label>
          <span class="muted" style="align-self:end;padding-bottom:8px">C: the other {100 - aItems - bItems}%</span>
          <input type="hidden" name="cls" value={cls} />
          <button class="secondary">Show</button>
        </form>
        <p class="muted">Ranked by {basisWord}, {result.period}. Total {money(result.total)}.</p>
        <nav class="tabs noprint" id="abc-classes">
          {(['A', 'B', 'C'] as const).map((k) => (
            <a href={classHref(k)} class={cls === k ? 'on' : ''}><span class={`abc-cls abc-${k}`}>{k}</span> {result.counts[k]} item{result.counts[k] === 1 ? '' : 's'} · {result.shares[k].toFixed(0)}%</a>
          ))}
        </nav>
        <p class="hint">{cls === 'A' ? `Class A: the top ${aItems}% of items by ${basis === 'gp' ? 'profit' : 'sales'}. They bring in ${result.shares.A.toFixed(1)}% of it. Keep them near the counter, count and order them often.`
          : cls === 'B' ? `Class B: the next ${bItems}% of items, ${result.shares.B.toFixed(1)}% of ${basis === 'gp' ? 'profit' : 'sales'}. Normal checks.`
          : cls === 'C' ? `Class C: the last ${100 - aItems - bItems}% of items, ${result.shares.C.toFixed(1)}% of ${basis === 'gp' ? 'profit' : 'sales'}. Keep stock lean and order as needed.`
          : 'Items with no sales in this period.'}
          {cls !== '-' ? <> <a href={classHref('-')}>{result.counts['-']} items had no sales in this period.</a></> : <> <a href={classHref('A')}>Back to class A.</a></>}</p>
        <div class="wrap"><table>
          <thead><tr><th class="n">#</th><th>Class</th><th>Code</th><th>Description</th><th class="n">Pack</th><th class="n">On hand</th><th class="n">Sold</th><th class="n">Sales excl</th><th class="n">GP</th><th class="n">Share</th><th class="n">Cum.</th><th>Bins</th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr data-href={`/items/${r.itemId}`} class={r.cls === '-' ? 'dim' : ''}>
              <td class="n">{r.rank ?? ''}</td>
              <td><span class={`abc-cls ${r.cls === '-' ? 'abc-x' : `abc-${r.cls}`}`}>{r.cls === '-' ? '–' : r.cls}</span></td>
              <td>{r.stockCode}</td><td><a href={`/items/${r.itemId}`}>{r.description || <em class="muted">no description</em>}</a></td>
              <td class="n">{r.packSize}</td><td class={`n ${r.onHandUnits < 0 ? 'neg' : ''}`}>{qty(r.onHandUnits, r.packSize)}</td>
              <td class="n">{r.qtyUnits ? qty(r.qtyUnits, r.packSize) : ''}</td><td class="n">{r.sales ? money(r.sales) : ''}</td><td class="n">{r.sales ? money(r.gp) : ''}</td>
              <td class="n">{r.rank ? pct(r.share) : ''}</td><td class="n">{r.rank ? pct(r.cumulative) : ''}</td>
              <td>{r.bins.map((b) => <span class="chip">{b}</span>)}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {!shown.length && <p class="muted">No items here.</p>}
        <p class="hint">Items that sold are ranked best first and split by how many there are: A the top {aItems}%, B the next {bItems}%, C the other {100 - aItems - bItems}%. The A items usually bring in about 80% of the {basis === 'gp' ? 'profit' : 'sales'} (the Pareto rule); the percentage on each tab shows what they actually did. Items with no sales are not ranked. Own trading counts till sales and dispensed scripts (a script paid at the till is counted once). {mover ? 'To move a shelf item, use the Bins tab.' : ''}</p>
      </>
    ))
  })

  r.get('/new', async (c) => {
    const settings = await run(c, getSettings)
    return page(c, 'New item', (
      <>
        <h1>New item</h1>
        <form method="post" action="/items" class="items-form">
          <div class="panel"><h2 style="margin-top:0">General</h2>{general(null)}</div>
          <div class="panel"><h2 style="margin-top:0">Pricing</h2>{pricing(null, settings)}</div>
          <button>Create item</button>
        </form>
      </>
    ))
  })

  r.post('/', async (c) => {
    const input = parseItemForm(await c.req.parseBody()) as ItemInput
    const item = await run(c, (tx) => createItem(tx, input, c.get('user').userId))
    return back(c, `/items/${item.id}`, { ok: 'Item created' })
  })

  r.get('/:id', async (c) => {
    const data = await run(c, async (tx) => {
      const item = await getItem(tx, c.req.param('id'))
      if (!item) throw new DomainError('unknown item', 'not_found', 404)
      const q = c.req.query('q') ?? ''
      return {
        q, status: c.req.query('status') || undefined,
        results: q ? await searchItems(tx, q, { status: c.req.query('status') || undefined, includeDormant: true, limit: 100 }) : [],
        item, settings: await getSettings(tx), movements: await itemMovements(tx, item.id, 100),
        reasons: await tx`select code, label from adjustment_reasons where active order by label`,
        prices: await tx`select cost_per_pack, retail_per_pack, effective_from, source from price_history where item_id = ${item.id} order by effective_from desc, id desc limit 12`,
      }
    })
    const { item: i, settings, movements, reasons, prices, q, status, results } = data
    const m = itemMargins(settings, i)
    const ruleRetail = i.costPerPack != null ? priceFor(settings, i.costPerPack, i.markupOverride, i.vatRate) : null
    return page(c, i.description || i.stockCode, (
      <>
        <form class="row panel" action="/items">
          <input name="q" value={q} data-search placeholder="Find another item: scan, or type a code or name  ( / )" style="flex:1" />
          {status && <input type="hidden" name="status" value={status} />}
          <button class="secondary">🔍 Find</button>
          <a class="btn secondary" href="/items/new">＋ New item</a>
          <button form="item-form">Save</button>
        </form>
        {results.length > 0 && <div class="records wrap"><table>
          <thead><tr><th>Code</th><th>Description</th><th class="n">Pack</th><th>Sch</th><th>NAPPI</th><th class="n">On hand</th><th class="n">Retail</th><th>Status</th></tr></thead>
          <tbody>{results.map((r) => (
            <tr data-href={itemHref(r.id, q, status)} class={r.id === i.id ? 'cur' : r.status === 'dormant' ? 'dim' : ''}>
              <td>{r.stockCode}</td><td>{r.description}</td><td class="n">{r.packSize}</td><td>{r.schedule === null ? '' : `S${r.schedule}`}</td><td>{r.nappiCode ?? ''}</td>
              <td class={`n ${r.onHandUnits < 0 ? 'neg' : ''}`}>{qty(r.onHandUnits, r.packSize)}</td><td class="n">{money(r.retailPerPack)}</td><td><StatusChip status={r.status} reason={r.statusReason} /></td>
            </tr>
          ))}</tbody>
        </table></div>}
        {results.length > 0 && <p class="hint" style="margin-top:4px">{results.length} found for "{q}". ↑ ↓ and Enter move through them.</p>}

        <div class="row"><h1>{i.description || i.stockCode}</h1><StatusChip status={i.status} reason={i.statusReason} /></div>
        {i.status === 'quarantined' && <div class="msg err">Quarantined: {i.statusReason}. Fix the record, then set the status to active.</div>}
        <div class="stats">
          <div class="stat"><b class={i.onHandUnits < 0 ? 'neg' : ''}>{qty(i.onHandUnits, i.packSize)}</b><span>on hand, packs of {i.packSize} ({i.onHandUnits} units)</span></div>
          <div class="stat"><b>{money(i.retailPerPack)}</b><span>retail per pack{ruleRetail !== null && ruleRetail !== i.retailPerPack ? `, rule gives ${money(ruleRetail)}` : ''}</span></div>
          <div class="stat"><b>{money(i.costPerPack)}</b><span>last cost; average {money(i.avgCostPerPack)}</span></div>
          <div class="stat"><b>{pct(m.gpPct)}</b><span>GP excl VAT (markup {pct(m.markupPct)})</span></div>
          <div class="stat"><b>{i.minUnits === null ? '–' : `${+(i.minUnits / i.packSize).toFixed(2)} / ${+(i.maxUnits! / i.packSize).toFixed(2)}`}</b><span>min / max packs {i.minmaxSource ? `(${i.minmaxSource})` : ''}</span></div>
        </div>

        <nav class="tabs" id="item-tabs">
          <a href="#general" data-tab="general">General</a><a href="#pricing" data-tab="pricing">Pricing</a>
          <a href="#stock" data-tab="stock">Stock</a><a href="#card" data-tab="card">Stock card</a>
        </nav>
        <form method="post" action={itemHref(i.id, q, status)} id="item-form">
          <section class="tab panel" data-tab="general">{general(i)}
            {i.externalRefs?.compharm_stock_id !== undefined && <p class="hint">Compharm stock ID {String(i.externalRefs.compharm_stock_id)}</p>}
            <div style="margin-top:12px"><button>Save</button></div></section>
          <section class="tab panel" data-tab="pricing">{pricing(i, settings)}
            <div style="margin-top:12px"><button>Save</button></div>
            <h2>Price history</h2>
            <div class="wrap"><table>
              <thead><tr><th>From</th><th class="n">Cost</th><th class="n">Retail</th><th>Source</th></tr></thead>
              <tbody>{prices.map((p: any) => <tr><td>{dateTime(p.effective_from)}</td><td class="n">{p.cost_per_pack === null ? '' : money(num(p.cost_per_pack))}</td><td class="n">{money(num(p.retail_per_pack))}</td><td>{p.source}</td></tr>)}</tbody>
            </table></div>
          </section>
        </form>

        <section class="tab" data-tab="stock">
          <div class="row" style="align-items:flex-start;gap:16px">
            <div class="panel" style="flex:1;min-width:260px">
              <h2 style="margin-top:0">Adjust stock</h2>
              <form method="post" action={itemHref(`${i.id}/adjust`, q, status)} class="grid">
                <label>Packs (+ or -)<input name="packs" type="number" step="any" placeholder="e.g. -1" /></label>
                <label>or units<input name="units" type="number" step="1" /></label>
                <label>Reason<select name="reason" required>{reasons.map((r: any) => <option value={r.code}>{r.label}</option>)}</select></label>
                <label style="grid-column:1/-1">Note<input name="note" /></label>
                <div><button>Post adjustment</button></div>
              </form>
            </div>
            <div class="panel" style="flex:1;min-width:260px">
              <h2 style="margin-top:0">Min / max levels</h2>
              <form method="post" action={itemHref(`${i.id}/minmax`, q, status)} class="grid">
                <label>Min (packs)<input name="min" type="number" step="any" min="0" value={i.minUnits === null ? '' : +(i.minUnits / i.packSize).toFixed(3)} /></label>
                <label>Max (packs)<input name="max" type="number" step="any" min="0" value={i.maxUnits === null ? '' : +(i.maxUnits / i.packSize).toFixed(3)} /></label>
                <div><button>Save levels</button></div>
              </form>
              <p class="hint">Saved here, levels count as set by hand and are kept when suggestions are applied.</p>
            </div>
          </div>
        </section>

        <section class="tab" data-tab="card">
          <div class="wrap"><table>
            <thead><tr><th>When</th><th>Type</th><th class="n">Units</th><th class="n">Balance</th><th class="n">Unit cost</th><th>Reason / note</th><th>By</th></tr></thead>
            <tbody>{movements.map((mv: any) => (
              <tr><td>{dateTime(mv.occurred_at)}</td><td>{mv.kind}</td><td class={`n ${mv.qty_units < 0 ? 'neg' : ''}`}>{mv.qty_units > 0 ? '+' : ''}{mv.qty_units}</td>
                <td class="n">{qty(Number(mv.balance), i.packSize)}</td><td class="n">{mv.unit_cost === null ? '' : money(num(mv.unit_cost))}</td>
                <td>{[mv.reason_code, mv.note].filter(Boolean).join(' · ')}</td><td>{mv.user_name ?? ''}</td></tr>
            ))}</tbody>
          </table></div>
          {!movements.length && <p class="muted">No movements yet.</p>}
        </section>
        <script>{raw(tabs)}</script>
      </>
    ))
  })

  r.post('/:id', async (c) => {
    const input = parseItemForm(await c.req.parseBody())
    await run(c, (tx) => updateItem(tx, c.req.param('id'), input, c.get('user').userId))
    return back(c, itemHref(c.req.param('id'), c.req.query('q') ?? '', c.req.query('status')), { ok: 'Saved' })
  })

  r.post('/:id/adjust', async (c) => {
    const b = await c.req.parseBody()
    const id = c.req.param('id')
    await run(c, async (tx) => {
      const item = await getItem(tx, id)
      if (!item) throw new DomainError('unknown item', 'not_found', 404)
      const units = optNum(b.units) ?? (optNum(b.packs) === null ? null : packsToUnits(optNum(b.packs)!, item.packSize))
      if (!units) throw new DomainError('enter a quantity in packs or units')
      await adjustStock(tx, { itemId: id, qtyUnits: units, reasonCode: String(b.reason), note: String(b.note ?? '') || undefined }, { userId: c.get('user').userId })
    })
    return back(c, itemHref(id, c.req.query('q') ?? '', c.req.query('status')), { ok: 'Adjustment posted' })
  })

  r.post('/:id/minmax', async (c) => {
    const b = await c.req.parseBody()
    const id = c.req.param('id')
    await run(c, async (tx) => {
      const item = await getItem(tx, id)
      if (!item) throw new DomainError('unknown item', 'not_found', 404)
      const min = optNum(b.min)
      const max = optNum(b.max)
      await setMinMax(tx, id, min === null ? null : Math.round(min * item.packSize * 1000) / 1000, max === null ? null : Math.round(max * item.packSize * 1000) / 1000, 'manual')
    })
    return back(c, itemHref(id, c.req.query('q') ?? '', c.req.query('status')), { ok: 'Levels saved' })
  })

  return r
}
