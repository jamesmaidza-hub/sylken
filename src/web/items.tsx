import { Hono } from 'hono'
import { raw } from 'hono/html'
import { num } from '../db/index.js'
import { DomainError } from '../domain/errors.js'
import { createItem, getItem, itemMargins, itemsByBin, listBins, moveItemsToBin, priceFor, searchItems, updateItem, type ItemInput } from '../domain/items.js'
import { setMinMax } from '../domain/minmax.js'
import { itemMovements } from '../domain/reports.js'
import { getSettings } from '../domain/settings.js'
import { adjustStock } from '../domain/stock.js'
import { packsToUnits } from '../domain/units.js'
import { back, can, page, run, type Env } from './app.js'
import { dateTime, money, pct, qty, StatusChip } from './layout.js'

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
  document.getElementById('bins-open').onclick = () => all().forEach((d) => { d.open = true })
  document.getElementById('bins-close').onclick = () => all().forEach((d) => { d.open = false })
  document.getElementById('bins-print').onclick = () => window.print()
  let was = []
  addEventListener('beforeprint', () => { was = [...all()].map((d) => d.open); all().forEach((d) => { d.open = true }) })
  addEventListener('afterprint', () => all().forEach((d, i) => { d.open = was[i] ?? d.open }))
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
        <div class="row"><h1>Items</h1><span class="spacer" /><a class="btn secondary" href="/items/bins">🗄 List by bin</a><a class="btn" href="/items/new">New item</a></div>
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
        <div class="row"><h1>Items by bin</h1><span class="spacer" />
          <a class="btn secondary noprint" href="/items">Search items</a>
          <button type="button" class="secondary noprint" id="bins-open">Open all</button>
          <button type="button" class="secondary noprint" id="bins-close">Close all</button>
          <button type="button" class="noprint" id="bins-print">🖨 Print list</button></div>
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
    const backTo = new URL(String(b.back ?? '').startsWith('/items/bins') ? String(b.back) : '/items/bins', 'http://x')
    for (const k of ['open', 'ok', 'err']) backTo.searchParams.delete(k)
    backTo.searchParams.set('open', target)
    return back(c, `${backTo.pathname}${backTo.search}`, { ok: `Moved ${n} item${n === 1 ? '' : 's'} to bin ${target}` })
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
