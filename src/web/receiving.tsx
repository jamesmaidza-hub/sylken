import { Hono } from 'hono'
import { DomainError } from '../domain/errors.js'
import { findByCode, searchItems } from '../domain/items.js'
import { addInvoiceLine, createInvoice, createSupplier, getInvoice, postInvoice, removeInvoiceLine } from '../domain/receiving.js'
import { back, page, run, type Env } from './app.js'
import { date, money } from './layout.js'

export function receivingRoutes() {
  const r = new Hono<Env>()

  r.get('/', async (c) => {
    const { invoices, suppliers } = await run(c, async (tx) => ({
      invoices: await tx`
        select si.id, si.invoice_no, si.invoice_date, si.status, s.name as supplier,
               (select count(*) from supplier_invoice_lines l where l.invoice_id = si.id)::int as lines,
               (select coalesce(sum(l.qty_packs * l.cost_per_pack), 0) from supplier_invoice_lines l where l.invoice_id = si.id) as total
          from supplier_invoices si join suppliers s on s.id = si.supplier_id
         order by si.created_at desc limit 100`,
      suppliers: await tx`select id, name from suppliers where active order by name`,
    }))
    const today = new Date().toISOString().slice(0, 10)
    return page(c, 'Receive stock', (
      <>
        <h1>Receive supplier invoices</h1>
        <form method="post" action="/receiving" class="grid panel">
          <label>Supplier
            <input name="supplier" list="suppliers" required placeholder="Pick or type a new supplier" autofocus />
            <datalist id="suppliers">{suppliers.map((s: any) => <option value={s.name} />)}</datalist>
          </label>
          <label>Invoice number<input name="invoiceNo" required /></label>
          <label>Invoice date<input name="invoiceDate" type="date" value={today} required /></label>
          <div><button>Start invoice</button></div>
        </form>
        <div class="wrap"><table>
          <thead><tr><th>Date</th><th>Supplier</th><th>Invoice</th><th class="n">Lines</th><th class="n">Total excl VAT</th><th>Status</th></tr></thead>
          <tbody>{invoices.map((i: any) => (
            <tr data-href={`/receiving/${i.id}`}><td>{date(i.invoice_date)}</td><td>{i.supplier}</td><td><a href={`/receiving/${i.id}`}>{i.invoice_no}</a></td>
              <td class="n">{i.lines}</td><td class="n">{money(Number(i.total))}</td><td>{i.status}</td></tr>
          ))}</tbody>
        </table></div>
      </>
    ))
  })

  r.post('/', async (c) => {
    const b = await c.req.parseBody()
    const id = await run(c, async (tx) => {
      const name = String(b.supplier ?? '').trim()
      const [existing] = await tx`select id from suppliers where lower(name) = lower(${name})`
      const supplierId = existing?.id ?? (await createSupplier(tx, { name }))
      return createInvoice(tx, { supplierId, invoiceNo: String(b.invoiceNo ?? ''), invoiceDate: String(b.invoiceDate) }, c.get('user').userId)
    })
    return c.redirect(`/receiving/${id}`)
  })

  r.get('/:id', async (c) => {
    const code = c.req.query('code')?.trim()
    const { inv, picked, matches } = await run(c, async (tx) => {
      const inv = await getInvoice(tx, c.req.param('id'))
      if (!inv) throw new DomainError('unknown invoice', 'not_found', 404)
      let picked = null
      let matches: any[] = []
      if (code) {
        picked = await findByCode(tx, code)
        if (!picked) matches = await searchItems(tx, code, { includeDormant: true, limit: 20 })
        if (matches.length === 1) { picked = matches[0]; matches = [] }
      }
      return { inv, picked, matches }
    })
    const draft = inv.status === 'draft'
    return page(c, `Invoice ${inv.invoiceNo}`, (
      <>
        <h1>{inv.supplierName} · invoice {inv.invoiceNo} <span class="muted">({inv.status})</span></h1>
        <p class="muted">Invoice date {date(inv.invoiceDate)}</p>
        {draft && (
          <div class="panel">
            <form class="row" method="get">
              <input name="code" value={code ?? ''} data-search placeholder="Scan or type the item  ( / )" style="flex:1" autofocus={!picked} />
              <button class="secondary">Find</button>
            </form>
            {matches.length > 0 && (
              <table style="margin-top:8px"><tbody>{matches.map((m) => (
                <tr data-href={`/receiving/${inv.id}?code=${encodeURIComponent(m.stockCode)}`}><td>{m.stockCode}</td><td>{m.description}</td><td>{m.status}</td></tr>
              ))}</tbody></table>
            )}
            {code && !picked && !matches.length && <p class="neg">No item matches "{code}". <a href="/items/new">Create it</a> first.</p>}
            {picked && (
              <form method="post" action={`/receiving/${inv.id}/lines`} class="grid" style="margin-top:10px">
                <input type="hidden" name="itemId" value={picked.id} />
                <div style="grid-column:1/-1"><b>{picked.description}</b> <span class="muted">{picked.stockCode} · pack of {picked.packSize} · last cost {money(picked.costPerPack)} · retail {money(picked.retailPerPack)}</span></div>
                <label>Packs<input name="qtyPacks" type="number" step="any" min="0" required autofocus /></label>
                <label>Free (bonus) packs<input name="bonusPacks" type="number" step="any" min="0" value="0" /></label>
                <label>Cost per pack, excl VAT<input name="costPerPack" type="number" step="0.0001" min="0" value={picked.costPerPack ?? ''} required /></label>
                <label class="row" style="flex-direction:row"><input type="checkbox" name="updateRetail" checked /> Re-price from markup</label>
                <div><button>Add line</button></div>
              </form>
            )}
          </div>
        )}
        <div class="wrap"><table>
          <thead><tr><th>#</th><th>Code</th><th>Description</th><th class="n">Packs</th><th class="n">Free</th><th class="n">Cost/pack</th><th class="n">Was</th><th class="n">New retail</th><th class="n">Line excl VAT</th><th></th></tr></thead>
          <tbody>{inv.lines.map((l) => (
            <tr><td>{l.lineNo}</td><td>{l.stockCode}</td><td>{l.description}</td><td class="n">{l.qtyPacks}</td><td class="n">{l.bonusPacks || ''}</td>
              <td class="n">{money(l.costPerPack)}</td><td class="n muted">{money(l.currentCost)}</td>
              <td class="n">{money(l.newRetail)}{l.newRetail !== l.currentRetail && <span class="muted"> (was {money(l.currentRetail)})</span>}</td>
              <td class="n">{money(l.lineExcl)}</td>
              <td>{draft && <form method="post" action={`/receiving/${inv.id}/lines/${l.id}/delete`}><button class="secondary">Remove</button></form>}</td></tr>
          ))}</tbody>
          <tfoot>
            <tr><td colspan={8} class="n">Total excl VAT</td><td class="n">{money(inv.totalExcl)}</td><td /></tr>
            <tr><td colspan={8} class="n">VAT</td><td class="n">{money(inv.vat)}</td><td /></tr>
            <tr><td colspan={8} class="n"><b>Total incl VAT</b></td><td class="n"><b>{money(inv.totalIncl)}</b></td><td /></tr>
          </tfoot>
        </table></div>
        {draft && inv.lines.length > 0 && (
          <form method="post" action={`/receiving/${inv.id}/post`} class="row" style="margin-top:12px">
            <span class="hint">Check the total against the paper invoice. Posting puts the stock on the shelf and updates costs and prices.</span>
            <span class="spacer" /><button>Post invoice</button>
          </form>
        )}
      </>
    ))
  })

  r.post('/:id/lines', async (c) => {
    const b = await c.req.parseBody()
    const id = c.req.param('id')
    await run(c, (tx) => addInvoiceLine(tx, id, {
      itemId: String(b.itemId), qtyPacks: Number(b.qtyPacks || 0), bonusPacks: Number(b.bonusPacks || 0),
      costPerPack: Number(b.costPerPack), updateRetail: b.updateRetail === 'on',
    }))
    return c.redirect(`/receiving/${id}`)
  })

  r.post('/:id/lines/:line/delete', async (c) => {
    await run(c, (tx) => removeInvoiceLine(tx, c.req.param('id'), c.req.param('line')))
    return c.redirect(`/receiving/${c.req.param('id')}`)
  })

  r.post('/:id/post', async (c) => {
    await run(c, (tx) => postInvoice(tx, c.req.param('id'), c.get('user').userId))
    return back(c, `/receiving/${c.req.param('id')}`, { ok: 'Invoice posted; stock and prices updated' })
  })

  return r
}
