import { Hono } from 'hono'
import { DomainError } from '../domain/errors.js'
import { findByCode } from '../domain/items.js'
import {
  addScanUpload, cancelStockTake, discardScanUpload, postStockTake, recordCount, scanUploadPreview, startStockTake, stockTakeSummary, uploadScanFile,
} from '../domain/stocktake.js'
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
    const { s, uploads } = await run(c, async (tx) => ({
      s: await stockTakeSummary(tx, c.req.param('id')),
      uploads: await tx`
        select u.id, u.file_name, u.status, u.scans, u.matched_items, jsonb_array_length(u.unknown_codes)::int as unknown, u.uploaded_at, us.name as by
          from stock_take_uploads u left join users us on us.id = u.uploaded_by
         where u.stock_take_id = ${c.req.param('id')} order by u.uploaded_at desc`,
    }))
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
        {counting && (
          <form method="post" action={`/stocktakes/${s.id}/upload`} enctype="multipart/form-data" class="grid panel" style="margin-top:12px">
            <label>Handheld scanner file (CipherLab)<input type="file" name="file" accept=".txt,.csv,.dat,.prn,text/plain" required /></label>
            <label>Numbers in the file are<select name="qtyUnit"><option value="packs">Packs (boxes on the shelf)</option><option value="units">Loose units (tablets, ml)</option></select></label>
            <label>Mode<select name="mode"><option value="add">Add to what is already counted</option><option value="set">Replace counts for items in the file</option></select></label>
            <div><button>Upload and check</button></div>
            <p class="hint" style="grid-column:1/-1">Put the handheld in its cradle, send the data to the PC with the CipherLab software, then pick the file it saved (usually a .txt). You'll see what the file says before any count changes, and stock only moves when the count is posted.</p>
          </form>
        )}
        {uploads.length > 0 && (
          <div class="wrap" style="margin-top:12px"><table>
            <thead><tr><th>Uploaded</th><th>File</th><th>By</th><th class="n">Scans</th><th class="n">Items</th><th class="n">Unknown codes</th><th>Status</th></tr></thead>
            <tbody>{uploads.map((u: any) => (
              <tr data-href={`/stocktakes/${s.id}/uploads/${u.id}`}><td>{dateTime(u.uploaded_at)}</td><td><a href={`/stocktakes/${s.id}/uploads/${u.id}`}>{u.file_name}</a></td>
                <td>{u.by ?? ''}</td><td class="n">{u.scans}</td><td class="n">{u.matched_items}</td><td class={`n ${u.unknown ? 'neg' : ''}`}>{u.unknown}</td>
                <td>{u.status === 'pending' ? 'waiting to be checked' : u.status}</td></tr>
            ))}</tbody>
          </table></div>
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

  r.post('/:id/upload', async (c) => {
    const id = c.req.param('id')
    const b = await c.req.parseBody()
    const f = b.file
    if (!(f instanceof File) || !f.size) return back(c, `/stocktakes/${id}`, { err: 'Choose the file the scanner software saved' })
    const bytes = new Uint8Array(await f.arrayBuffer())
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { text = new TextDecoder('latin1').decode(bytes) }
    const uploadId = await run(c, (tx) => uploadScanFile(tx, id, { name: f.name, text },
      { qtyUnit: b.qtyUnit === 'units' ? 'units' : 'packs', mode: b.mode === 'set' ? 'set' : 'add' }, c.get('user').userId))
    return c.redirect(`/stocktakes/${id}/uploads/${uploadId}`)
  })

  r.get('/:id/uploads/:upload', async (c) => {
    const id = c.req.param('id')
    const p = await run(c, (tx) => scanUploadPreview(tx, c.req.param('upload')))
    if (!p || p.stockTakeId !== id) throw new DomainError('unknown upload', 'not_found', 404)
    const pending = p.status === 'pending'
    const notInCount = p.lines.filter((l) => !l.inCount).length
    return page(c, `Scanner file ${p.fileName}`, (
      <>
        <h1>Scanner file {p.fileName} <span class="muted">({pending ? 'waiting to be checked' : p.status})</span></h1>
        <p><a href={`/stocktakes/${id}`}>Back to the count</a></p>
        <div class="stats">
          <div class="stat"><b>{p.scans}</b><span>scans in the file</span></div>
          <div class="stat"><b>{p.lines.length}</b><span>items found</span></div>
          <div class="stat"><b class={p.unknown.length ? 'neg' : ''}>{p.unknown.length}</b><span>codes sylken doesn't know</span></div>
          <div class="stat"><b class={p.skipped.length ? 'neg' : ''}>{p.skipped.length}</b><span>lines it couldn't read</span></div>
        </div>
        <p class="hint">Numbers in the file read as {p.qtyUnit === 'packs' ? 'packs' : 'loose units'}. {p.mode === 'add' ? 'They are added to what is already counted.' : 'They replace the count for each item in the file.'}
          {notInCount ? ` ${notInCount} item${notInCount === 1 ? ' is' : 's are'} not in this count's list yet and will be added to it.` : ''}</p>
        {pending && (
          <div class="panel row" style="margin:12px 0">
            <form method="post" action={`/stocktakes/${id}/uploads/${p.id}/add`}><button>Add these counts</button></form>
            <span class="spacer" />
            <form method="post" action={`/stocktakes/${id}/uploads/${p.id}/discard`}><button class="secondary">Discard this file</button></form>
          </div>
        )}
        {p.unknown.length > 0 && (
          <>
            <h2>Codes sylken doesn't know</h2>
            <p class="hint">These are left out. Add the barcode to the right item (or count it by hand), then upload the file again if you need to.</p>
            <div class="wrap"><table>
              <thead><tr><th>Code</th><th class="n">Quantity</th><th>Line in file</th></tr></thead>
              <tbody>{p.unknown.map((u) => <tr><td>{u.code}</td><td class="n">{u.qty}</td><td>{u.lines.slice(0, 10).join(', ')}{u.lines.length > 10 ? '…' : ''}</td></tr>)}</tbody>
            </table></div>
          </>
        )}
        {p.skipped.length > 0 && (
          <>
            <h2>Lines it couldn't read</h2>
            <div class="wrap"><table>
              <thead><tr><th>Line</th><th>Text</th><th>Why</th></tr></thead>
              <tbody>{p.skipped.slice(0, 200).map((l) => <tr><td>{l.line}</td><td><code>{l.text}</code></td><td>{l.reason}</td></tr>)}</tbody>
            </table></div>
          </>
        )}
        <h2>Items</h2>
        <div class="wrap"><table>
          <thead><tr><th>Code</th><th>Description</th><th class="n">In file</th><th class="n">Expected</th><th class="n">Counted before</th><th class="n">Counted after</th></tr></thead>
          <tbody>{p.lines.map((l) => (
            <tr><td>{l.stockCode}</td><td><a href={`/items/${l.itemId}`}>{l.description}</a></td><td class="n">{qty(l.units, l.packSize)}</td>
              <td class="n">{l.expectedUnits === null ? '–' : qty(l.expectedUnits, l.packSize)}</td>
              <td class="n">{l.countedBefore === null ? '–' : qty(l.countedBefore, l.packSize)}</td>
              <td class="n">{qty(l.countedAfter, l.packSize)}</td></tr>
          ))}</tbody>
        </table></div>
      </>
    ))
  })

  r.post('/:id/uploads/:upload/add', async (c) => {
    const id = c.req.param('id')
    const res = await run(c, async (tx) => {
      const [u] = await tx`select stock_take_id from stock_take_uploads where id = ${c.req.param('upload')}`
      if (!u || u.stock_take_id !== id) throw new DomainError('unknown upload', 'not_found', 404)
      return addScanUpload(tx, c.req.param('upload'), c.get('user').userId)
    })
    return back(c, `/stocktakes/${id}`, { ok: `Added counts for ${res.items} items from the scanner file.${res.unknown ? ` ${res.unknown} unknown codes were left out.` : ''} Check the differences, then post the count.` })
  })

  r.post('/:id/uploads/:upload/discard', async (c) => {
    const id = c.req.param('id')
    await run(c, async (tx) => {
      const [u] = await tx`select stock_take_id from stock_take_uploads where id = ${c.req.param('upload')}`
      if (!u || u.stock_take_id !== id) throw new DomainError('unknown upload', 'not_found', 404)
      await discardScanUpload(tx, c.req.param('upload'), c.get('user').userId)
    })
    return back(c, `/stocktakes/${id}`, { ok: 'Scanner file discarded. No counts were changed.' })
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
