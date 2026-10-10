import { Hono } from 'hono'
import { DomainError } from '../domain/errors.js'
import { findByCode } from '../domain/items.js'
import { cancelStockTake, postStockTake, recordCount, startStockTake, stockTakeSummary } from '../domain/stocktake.js'
import { packsToUnits } from '../domain/units.js'
import { back, page, run, type Env } from './app.js'
import { dateTime, money, qty } from './layout.js'

export function stockTakeRoutes() {
  const r = new Hono<Env>()

  r.get('/', async (c) => {
    const { takes, bins } = await run(c, async (tx) => ({
      takes: await tx`
        select st.id, st.name, st.status, st.started_at, st.posted_at, b.name as bin,
               (select count(*) from stock_take_lines l where l.stock_take_id = st.id)::int as lines,
               (select count(*) from stock_take_lines l where l.stock_take_id = st.id and l.counted_units is not null)::int as counted
          from stock_takes st left join bins b on b.id = st.bin_id order by st.started_at desc limit 50`,
      bins: await tx`select id, name from bins order by name`,
    }))
    return page(c, 'Stock take', (
      <>
        <h1>Stock takes</h1>
        <form method="post" action="/stocktakes" class="grid panel">
          <label>Name<input name="name" required value={`Count ${new Date().toISOString().slice(0, 10)}`} /></label>
          <label>Scope<select name="binId"><option value="">Whole shop</option>{bins.map((b: any) => <option value={b.id}>Bin {b.name}</option>)}</select></label>
          <div><button>Start count</button></div>
        </form>
        <p class="hint">Starting a count freezes the expected quantities. Sales during the count are kept: each item moves by the difference between counted and expected.</p>
        <div class="wrap"><table>
          <thead><tr><th>Started</th><th>Name</th><th>Scope</th><th class="n">Counted</th><th>Status</th></tr></thead>
          <tbody>{takes.map((t: any) => (
            <tr data-href={`/stocktakes/${t.id}`}><td>{dateTime(t.started_at)}</td><td><a href={`/stocktakes/${t.id}`}>{t.name}</a></td>
              <td>{t.bin ?? 'Whole shop'}</td><td class="n">{t.counted} / {t.lines}</td><td>{t.status}</td></tr>
          ))}</tbody>
        </table></div>
      </>
    ))
  })

  r.post('/', async (c) => {
    const b = await c.req.parseBody()
    const id = await run(c, (tx) => startStockTake(tx, { name: String(b.name), binId: String(b.binId || '') || null }, c.get('user').userId))
    return c.redirect(`/stocktakes/${id}`)
  })

  r.get('/:id', async (c) => {
    const show = c.req.query('show') ?? 'variances'
    const s = await run(c, (tx) => stockTakeSummary(tx, c.req.param('id')))
    if (!s) throw new DomainError('unknown stock take', 'not_found', 404)
    const lines = show === 'all' ? s.lines : show === 'uncounted' ? s.lines.filter((l) => l.countedUnits === null) : s.lines.filter((l) => l.varianceUnits)
    const counting = s.status === 'counting'
    return page(c, s.name, (
      <>
        <h1>{s.name} <span class="muted">({s.binName ? `bin ${s.binName}` : 'whole shop'}, {s.status})</span></h1>
        <div class="stats">
          <div class="stat"><b>{s.countedLines} / {s.totalLines}</b><span>items counted</span></div>
          <div class="stat"><b class={s.varianceValue < 0 ? 'neg' : ''}>{money(s.varianceValue)}</b><span>variance at cost so far</span></div>
        </div>
        {counting && (
          <form method="post" action={`/stocktakes/${s.id}/count`} class="grid panel" style="margin-top:12px">
            <label>Scan or type code<input name="code" data-search required autofocus /></label>
            <label>Packs<input name="packs" type="number" step="any" min="0" placeholder="whole packs" /></label>
            <label>Loose units<input name="units" type="number" step="1" min="0" placeholder="0" /></label>
            <label>Mode<select name="mode"><option value="add">Add to count (item on several shelves)</option><option value="set">Replace count</option></select></label>
            <div><button>Record</button></div>
          </form>
        )}
        <div class="row" style="margin:8px 0">
          {[['variances', 'Differences'], ['uncounted', 'Not counted yet'], ['all', 'All lines']].map(([k, label]) => (
            <a class={`btn ${k === show ? '' : 'secondary'}`} href={`?show=${k}`}>{label}</a>
          ))}
        </div>
        <div class="wrap"><table>
          <thead><tr><th>Code</th><th>Description</th><th class="n">Expected</th><th class="n">Counted</th><th class="n">Difference</th><th class="n">Value</th></tr></thead>
          <tbody>{lines.slice(0, 500).map((l) => (
            <tr><td>{l.stockCode}</td><td><a href={`/items/${l.itemId}`}>{l.description}</a></td><td class="n">{qty(l.expectedUnits, l.packSize)}</td>
              <td class="n">{l.countedUnits === null ? '–' : qty(l.countedUnits, l.packSize)}</td>
              <td class={`n ${(l.varianceUnits ?? 0) < 0 ? 'neg' : ''}`}>{l.varianceUnits === null ? '' : qty(l.varianceUnits, l.packSize)}</td>
              <td class="n">{l.varianceValue === null ? '' : money(l.varianceValue)}</td></tr>
          ))}</tbody>
        </table></div>
        {lines.length > 500 && <p class="muted">Showing 500 of {lines.length} lines.</p>}
        {counting && (
          <div class="panel row" style="margin-top:12px">
            <form method="post" action={`/stocktakes/${s.id}/post`} class="row">
              <label class="row"><input type="checkbox" name="zeroUncounted" /> Set items not counted to zero</label>
              <button>Post stock take</button>
            </form>
            <span class="spacer" />
            <form method="post" action={`/stocktakes/${s.id}/cancel`}><button class="secondary">Cancel count</button></form>
          </div>
        )}
      </>
    ))
  })

  r.post('/:id/count', async (c) => {
    const b = await c.req.parseBody()
    const id = c.req.param('id')
    const msg = await run(c, async (tx) => {
      const item = await findByCode(tx, String(b.code ?? ''))
      if (!item) throw new DomainError(`no item with code ${b.code}`)
      const packs = Number(b.packs || 0)
      const loose = Number(b.units || 0)
      const units = packsToUnits(packs, item.packSize) + loose
      const res = await recordCount(tx, id, item.id, units, b.mode === 'set' ? 'set' : 'add', c.get('user').userId)
      return `${item.description}: counted ${qty(res.counted, item.packSize)}, expected ${qty(res.expected, item.packSize)}`
    })
    return back(c, `/stocktakes/${id}`, { ok: msg })
  })

  r.post('/:id/post', async (c) => {
    const b = await c.req.parseBody()
    const n = await run(c, (tx) => postStockTake(tx, c.req.param('id'), { zeroUncounted: b.zeroUncounted === 'on' }, c.get('user').userId))
    return back(c, `/stocktakes/${c.req.param('id')}`, { ok: `Posted. ${n} items adjusted.` })
  })

  r.post('/:id/cancel', async (c) => {
    await run(c, (tx) => cancelStockTake(tx, c.req.param('id'), c.get('user').userId))
    return c.redirect('/stocktakes')
  })

  return r
}
