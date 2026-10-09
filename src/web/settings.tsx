import { Hono } from 'hono'
import { findByCode, repriceItems } from '../domain/items.js'
import { buttonColors, getSettings, parseTillButtons, updateSettings } from '../domain/settings.js'
import { back, page, requireRole, run, type Env } from './app.js'

export function settingsRoutes() {
  const r = new Hono<Env>()

  r.get('/', async (c) => {
    const s = await run(c, getSettings)
    return page(c, 'Settings', (
      <>
        <h1>Shop settings</h1>
        <form method="post" action="/settings" class="grid panel">
          <label>VAT %<input name="vatPct" type="number" step="0.01" value={(s.vatRate * 100).toFixed(2)} /></label>
          <label>Default markup on cost %<input name="markupPct" type="number" step="0.01" value={(s.defaultMarkup * 100).toFixed(2)} /></label>
          <label>Round retail up to (P)<input name="rounding" type="number" step="0.01" min="0.01" value={s.retailRounding} /></label>
          <label>Min level = days of usage<input name="minDays" type="number" min="0" value={s.minmaxMinDays} /></label>
          <label>Max level = days of usage<input name="maxDays" type="number" min="1" value={s.minmaxMaxDays} /></label>
          <label>Months of sales used for usage<input name="usageMonths" type="number" min="1" max="24" value={s.minmaxUsageMonths} /></label>
          <label>Highest believable cost per pack (P)<input name="maxSaneCost" type="number" min="1" value={s.maxSaneCost} /></label>
          <label>Till float to start a run (P)<input name="defaultFloat" type="number" step="0.01" min="0" value={s.defaultFloat.toFixed(2)} /></label>
          <label>Round cash to (P)<input name="cashRounding" type="number" step="0.01" min="0.01" value={s.cashRounding.toFixed(2)} /></label>
          <label>VAT number (printed on till slips)<input name="vatNumber" value={s.vatNumber ?? ''} /></label>
          <label>Till slip footer<input name="receiptFooter" value={s.receiptFooter ?? ''} placeholder="Thank you. Get well soon." /></label>
          <label class="row" style="flex-direction:row"><input type="checkbox" name="allowNegative" checked={s.allowNegativeStock} /> Allow stock to go negative</label>
          <div><button>Save settings</button></div>
        </form>
        <p class="hint">
          Retail = cost × (1 + markup) × (1 + VAT). With the defaults that is cost × {((1 + s.defaultMarkup) * (1 + s.vatRate)).toFixed(3)}.
          Changing VAT or markup does not re-price items by itself.
        </p>
        <h2>Till quick buttons</h2>
        <form method="post" action="/settings/till-buttons" class="panel" style="display:grid;gap:8px">
          <label class="f">One item per line: stock code or barcode, then the button label, then a colour ({buttonColors.join(', ')})
            <textarea name="buttons" rows={8} style="font-family:ui-monospace,monospace" placeholder={'6009695580167, Panado syrup, green\nUSER141, Ibuprofen 100, blue'}>{s.tillButtons.map((b) => `${b.code}, ${b.label}, ${b.color}`).join('\n')}</textarea></label>
          <div><button>Save till buttons</button></div>
        </form>
        <p class="hint">These show on the till's touch layout, so the items sold most are one tap away.</p>
        <h2>Dispensary quick buttons</h2>
        <form method="post" action="/settings/rx-buttons" class="panel" style="display:grid;gap:8px">
          <label class="f">Same layout: stock code or barcode, label, colour
            <textarea name="buttons" rows={8} style="font-family:ui-monospace,monospace" placeholder={'6009695240702, Augmentin 625, blue'}>{s.rxButtons.map((b) => `${b.code}, ${b.label}, ${b.color}`).join('\n')}</textarea></label>
          <div><button>Save dispensary buttons</button></div>
        </form>
        <p class="hint">These show on the script screen's touch layout, beside the most used directions.</p>
        <form method="post" action="/settings/reprice" class="panel row">
          <span>Re-price every active item from its cost using the rule above.</span><span class="spacer" />
          <button class="danger">Re-price all items</button>
        </form>
      </>
    ))
  })

  r.post('/', async (c) => {
    requireRole(c, ['owner'])
    const b = await c.req.parseBody()
    await run(c, (tx) => updateSettings(tx, {
      vatRate: Number(b.vatPct) / 100,
      defaultMarkup: Number(b.markupPct) / 100,
      retailRounding: Number(b.rounding),
      minmaxMinDays: Number(b.minDays),
      minmaxMaxDays: Number(b.maxDays),
      minmaxUsageMonths: Number(b.usageMonths),
      maxSaneCost: Number(b.maxSaneCost),
      allowNegativeStock: b.allowNegative === 'on',
      defaultFloat: Number(b.defaultFloat || 0),
      cashRounding: Number(b.cashRounding || 0.01),
      vatNumber: String(b.vatNumber ?? '').trim() || null,
      receiptFooter: String(b.receiptFooter ?? '').trim() || null,
    }, c.get('user').userId))
    return back(c, '/settings', { ok: 'Settings saved' })
  })

  r.post('/till-buttons', async (c) => {
    requireRole(c, ['owner'])
    const b = await c.req.parseBody()
    const n = await run(c, async (tx) => {
      const buttons = await parseTillButtons(tx, String(b.buttons ?? ''), findByCode)
      await updateSettings(tx, { tillButtons: buttons }, c.get('user').userId)
      return buttons.length
    })
    return back(c, '/settings', { ok: `${n} till buttons saved. Reload the till to see them.` })
  })

  r.post('/rx-buttons', async (c) => {
    requireRole(c, ['owner'])
    const b = await c.req.parseBody()
    const n = await run(c, async (tx) => {
      const buttons = await parseTillButtons(tx, String(b.buttons ?? ''), findByCode)
      await updateSettings(tx, { rxButtons: buttons }, c.get('user').userId)
      return buttons.length
    })
    return back(c, '/settings', { ok: `${n} dispensary buttons saved` })
  })

  r.post('/reprice', async (c) => {
    requireRole(c, ['owner'])
    const n = await run(c, async (tx) => {
      const ids = (await tx`select id from items where status = 'active'`).map((x) => x.id as string)
      return repriceItems(tx, ids, c.get('user').userId)
    })
    return back(c, '/settings', { ok: `${n} prices changed` })
  })

  return r
}
