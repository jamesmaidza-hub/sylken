// sylken till. Runs in the browser and keeps working offline: the item list, the open run and
// every sale it rings up live in localStorage, and an outbox of recorded operations is sent to
// /api/till/sync whenever the server can be reached. Each operation carries an id made here,
// so sending one twice records it once.
//
// The till's rules (james, 2026-10-11): the float is counted blind; one run per till; a discount
// over the cashier's limit, a typed price, a line taken off once it is saved, a refund, petty cash,
// a no-sale and a cash drop each need a supervisor's code and second PIN, checked on the server.
import * as B from './basket.js'
;(() => {
  'use strict'
  const boot = window.SYLKEN
  const key = (k) => `sylken:${boot.tenantId}:${k}`
  const load = (k, d) => { try { const v = localStorage.getItem(key(k)); return v === null ? d : JSON.parse(v) } catch { return d } }
  const save = (k, v) => { try { localStorage.setItem(key(k), JSON.stringify(v)) } catch (e) { banner('This browser could not save the till data: ' + e.message, true) } }
  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const round2 = B.round2
  const money = (n) => (n < 0 ? '-' : '') + 'P' + Math.abs(n).toLocaleString('en-BW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID()
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  // Prices, VAT and rounding come from the basket engine the server uses too (basket.js).
  const linePrice = B.linePrice
  const roundCash = (n) => B.roundCash(n, (cat && cat.tenant.cashRounding) || 0.01)
  const vatIn = B.vatIn
  const limits = () => ({ maxChange: 200, cashDropThreshold: 2000, cashierDiscountPct: 10, cardTerminal: 'standalone', ...((cat && cat.tenant) || {}) })
  const slipRef = (id) => String(id).slice(0, 8).toUpperCase()
  const tenderNames = { cash: 'Cash', card: 'Card', cheque: 'Cheque', eft: 'EFT', account: 'Account', medical_aid: 'Medical aid' }
  const deviceId = load('device', null) || (() => { const d = 'web-' + uuid().slice(0, 8); save('device', d); return d })()

  let cat = load('catalogue', null)          // { items, accounts, tills, tenant, user, at }
  let tillId = load('till', null)
  let run = load('run', null)                // { id, tillId, openedAt, float, runNo? }
  let outbox = load('outbox', [])
  let failed = load('failed', [])
  let lastSlip = load('lastSlip', null)
  let user = (cat && cat.user && cat.user.id === boot.user.id) ? cat.user : boot.user
  let cart = newCart()
  let sel = -1
  let results = []
  let resultSel = 0
  let online = navigator.onLine
  let byCode = new Map()

  // The cart's id becomes the sale's id, so a supervisor's approval can name the sale before it is paid.
  function newCart(kind = 'sale') { return { id: uuid(), kind, lines: [], refundOf: null, refundRef: null, refundApproval: null, script: null, tendering: false } }

  function index() {
    byCode = new Map()
    if (!cat) return
    for (const it of cat.items) {
      byCode.set(it.c.toUpperCase(), it)
      for (const b of it.b || []) byCode.set(b.toUpperCase(), it)
      if (it.x && !byCode.has(it.x)) byCode.set(it.x, it)          // NAPPI code
    }
  }

  // ------------------------------------------------------------ screen

  function banner(text, bad) {
    const b = $('banner')
    b.hidden = !text
    b.className = 'banner' + (bad ? ' bad' : '')
    b.innerHTML = text || ''
    if (text && bad) beep()
  }

  // A short low tone when something needs the cashier's eyes, e.g. a barcode that matched nothing.
  let audio = null
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)()
      const o = audio.createOscillator(), g = audio.createGain()
      o.frequency.value = 330; g.gain.value = 0.08
      o.connect(g); g.connect(audio.destination)
      o.start(); o.stop(audio.currentTime + 0.18)
    } catch { /* no sound available */ }
  }

  /** Stock on hand as the shop counts it: whole packs, plus loose units if any. */
  function stockText(it) {
    const s = it.s ?? null
    if (s === null) return ''
    if (s <= 0) return '<span class="stock out">none in stock</span>'
    const n = it.n || 1
    const packs = Math.floor(s / n), loose = s % n
    const t = n === 1 ? `${s}` : packs && loose ? `${packs} + ${loose} loose` : packs ? `${packs}` : `${loose} loose`
    return `<span class="stock">${t} in stock</span>`
  }

  /** The name behind the code typed in the header box, so the cashier sees at once that it was read right. */
  function showCashier() {
    const code = String($('cashier-code').value || '').trim().toUpperCase()
    const who = (cat && cat.staff || []).find((s) => s.c === code)
    $('cashier').textContent = who ? who.n : code.length === 2 ? 'unknown code' : ''
    $('cashier').className = who ? '' : 'muted'
    if (who && /cashier code|staff code/.test($('banner').textContent)) banner('')    // the "type your code" message has done its job
  }
  $('cashier-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2)
    showCashier()
  })
  $('cashier-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('scan').focus() } })

  function header() {
    const t = cat && cat.tills.find((x) => x.id === tillId)
    $('till-label').textContent = t ? `${t.name} (${t.code})` : 'No till chosen'
    $('run-label').textContent = run ? (run.runNo ? `Run ${run.runNo}` : 'Run (not sent yet)') : 'No run open'
    showCashier()
    const net = $('net')
    net.textContent = online ? 'Online' : 'Offline: sales are kept on this till'
    net.className = 'net ' + (online ? 'on' : 'off')
    $('pending').textContent = outbox.length ? `${outbox.length} waiting to send` : ''
    const f = $('failed')
    f.hidden = !failed.length
    f.innerHTML = failed.length ? `<b>${failed.length} not accepted by the server.</b> They are kept on the server's list of till problems for the back office to sort out.<br><button class="secondary" id="clear-failed" type="button">Hide</button>` : ''
    if (failed.length) $('clear-failed').onclick = () => { failed = []; save('failed', failed); header() }
  }

  /** Every figure for the basket, from the shared engine: subtotal, discounts, VAT per rate, total. */
  function totals() {
    return B.basketTotals(cart.lines.map((l) => ({ listTotal: l.listTotal, lineTotal: l.lineTotal, vatRate: l.v ?? (cat && cat.tenant.vatRate) ?? 0.14 })))
  }

  function render() {
    const tb = $('lines')
    tb.innerHTML = cart.lines.map((l, i) => {
      const changed = l.lineTotal !== l.listTotal
      const qty = l.units % l.n === 0 ? String(l.units / l.n) : `${l.units}/${l.n}`
      return `<tr class="${i === sel ? 'sel' : ''}" data-i="${i}"><td>${l.sl ? `<span class="rx">Rx ${esc(cart.script.scriptNo)}</span> ` : ''}${esc(l.d)} <span class="code">${esc(l.c)}</span>${l.adj ? ` <span class="muted">${l.adj.kind === 'override' ? 'price changed' : `${B.discountPct(l.listTotal, l.lineTotal)}% off`}</span>` : ''}</td>
        <td class="n">${qty}</td><td class="n">${money(l.p)}</td>
        <td class="n">${changed ? `<span class="was">${money(l.listTotal)}</span>` : ''}${money(l.lineTotal)}</td></tr>`
    }).join('')
    $('empty').hidden = cart.lines.length > 0
    if (cart.lines.length) $('last').hidden = true
    const t = totals()
    $('total').textContent = money(t.total)
    const count = cart.lines.length
    $('count').textContent = count ? `${count} line${count === 1 ? '' : 's'}${t.discount ? ` · ${money(t.discount)} off` : ''} · VAT ${money(t.vat)}` : ''
    $('due-label').textContent = cart.kind === 'refund' ? 'To refund' : 'To pay'
    document.querySelector('.due').classList.toggle('refund', cart.kind === 'refund')
    $('mode').hidden = cart.kind !== 'refund'
    $('mode').textContent = cart.refundRef ? `REFUND of ${cart.refundRef}` : 'REFUND'
    header()
  }

  function showResults() {
    const ul = $('results')
    ul.hidden = !results.length
    ul.innerHTML = results.map((it, i) => `<li class="${i === resultSel ? 'sel' : ''}${it.z ? ' dormant' : ''}" data-i="${i}"><span class="code">${esc(it.c)}</span>
      <span class="desc">${esc(it.d)}${it.z ? ' <span class="muted">(dormant)</span>' : ''}</span>${stockText(it)}<span class="price">${money(it.p)}${it.n > 1 ? ` <span class="muted">/ ${it.n}</span>` : ''}</span></li>`).join('')
    const on = ul.querySelector('li.sel')
    if (on) on.scrollIntoView({ block: 'nearest' })
  }

  // ------------------------------------------------------------ modal forms

  let modalDone = null
  function ask(html, onOpen) {
    return new Promise((resolve) => {
      const m = $('modal')
      const f = $('modal-form')
      if (results.length) { results = []; showResults() }
      f.innerHTML = html
      m.hidden = false
      modalDone = (v) => { m.hidden = true; f.innerHTML = ''; modalDone = null; $('scan').focus(); resolve(v) }
      f.onsubmit = (e) => { e.preventDefault(); if (f.dataset.busy) return; modalDone(Object.fromEntries(new FormData(f))) }
      f.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = () => modalDone(null)))
      if (onOpen) onOpen(f)
      const first = f.querySelector('[autofocus]') || f.querySelector('input,select,button')
      if (first) { first.focus(); if (first.select) first.select() }
    })
  }
  const buttons = (ok = 'OK') => `<div class="row"><button type="button" class="secondary" data-cancel>Cancel (Esc)</button><button>${ok} (Enter)</button></div>`
  const num = (v) => { const n = Number(String(v ?? '').replace(/[P,\s]/gi, '')); return Number.isFinite(n) ? n : NaN }

  async function chooseTill() {
    if (!cat || !cat.tills.length) { banner('No tills are set up. Add one in the back office under Cash-up, then reload.', true); return false }
    if (cat.tills.length === 1) { tillId = cat.tills[0].id; save('till', tillId); return true }
    const v = await ask(`<h2>Which till is this?</h2><label>Till<select name="till" autofocus>${cat.tills.map((t) => `<option value="${t.id}">${esc(t.name)} (${esc(t.code)})</option>`).join('')}</select></label>${buttons('Use this till')}`)
    if (!v) return false
    tillId = v.till
    save('till', tillId)
    return true
  }

  async function ensureRun() {
    if (run) return true
    if (!tillId && !(await chooseTill())) return false
    // One run per till: if the server already has one open here (this browser lost its copy), carry on with it.
    if (online) {
      try {
        const res = await fetch('/api/till/open-run?till=' + encodeURIComponent(tillId), { credentials: 'same-origin' })
        if (res.ok) {
          const body = await res.json()
          if (body.run) {
            const v = await ask(`<h2>Run ${body.run.runNo} is open on this till</h2><p>It was opened ${esc(new Date(body.run.openedAt).toLocaleString('en-GB'))}${body.run.cashierCode ? ` by ${esc(body.run.cashierCode)}` : ''}. A till can only have one run open.</p>
              <p class="muted">Carry on with it, or cash it up in the back office first.</p>${buttons('Carry on with this run')}`)
            if (!v) return false
            run = { id: body.run.id, tillId, openedAt: body.run.openedAt, runNo: body.run.runNo, cash: null }
            save('run', run)
            header()
            return true
          }
        }
      } catch { /* offline: open a new run; the server refuses it if one is already open */ }
    }
    // Opening is blind: the cashier counts the float in the drawer and types it, with nothing filled in.
    if (needCode()) return false
    const cashier = cashierNow()
    const v = await ask(`<h2>Open a till run</h2><p>Count the float in the drawer and type what you counted.</p>
      <p class="muted">The drawer will be yours (${esc(cashier.n)}, ${esc(cashier.c)}) until it is cashed up.</p>
      <label>Opening float counted (P)<input name="float" inputmode="decimal" value="" autofocus required></label>${buttons('Open run')}`)
    if (!v) return false
    const float = String(v.float).trim() === '' ? NaN : num(v.float)
    if (!(float >= 0)) { banner('Type the float you counted, in Pula.', true); return false }
    run = { id: uuid(), tillId, openedAt: new Date().toISOString(), float, cash: round2(float), cashierCode: cashier.c }
    save('run', run)
    queue({ type: 'open_run', data: { id: run.id, tillId, openingFloat: float, openedAt: run.openedAt, cashierCode: cashier.c } })
    header()
    return true
  }

  // ------------------------------------------------------------ supervisor approval

  /**
   * Ask for a supervisor's staff code and second PIN, and have the server check them. Returns the
   * approval ({ id, name }) or null. Needs the server: PINs are never kept on the till.
   */
  async function approve(action, title, detail, subjectId) {
    let err = ''
    for (;;) {
      const v = await ask(`<h2>Supervisor needed</h2><p>${title}</p>
        <label>Supervisor's staff code<input name="code" maxlength="2" autocomplete="off" autocapitalize="characters" autofocus></label>
        <label>Their second PIN<input name="pin" type="password" inputmode="numeric" autocomplete="off"></label>
        ${err ? `<p class="err">${esc(err)}</p>` : ''}${buttons('Allow')}`)
      if (!v) return null
      try {
        const res = await fetch('/api/till/approve', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tillId, subjectId, action, detail, staffCode: String(v.code || '').toUpperCase(), pin: String(v.pin || ''), cashierCode: (cashierNow() || {}).c || null }),
        })
        setOnline(true)
        const body = await res.json().catch(() => ({}))
        if (res.status === 401) { banner('Your login has expired. <a href="/login">Log in again</a>.', true); return null }
        if (!res.ok) { err = body.error || 'Not allowed.'; continue }
        banner(`Allowed by ${esc(body.name)}.`)
        return body
      } catch {
        setOnline(false)
        banner('A supervisor\'s approval needs the server. Try again when the till is back online.', true)
        return null
      }
    }
  }

  // ------------------------------------------------------------ cash drawer

  // The drawer opens only for a cash sale or refund, a cash drop, or a no-sale a supervisor allowed.
  // sylken does not drive a drawer itself yet: a drawer driver can set window.SylkenDrawer = { open(reason) }.
  function openDrawer(reason) {
    try { if (window.SylkenDrawer && typeof window.SylkenDrawer.open === 'function') window.SylkenDrawer.open(reason) } catch { /* drawer not connected */ }
  }

  // Cash in the drawer, tracked on the till so the alert works offline. It is never shown: cash-up is blind.
  let serverDropDue = false
  function moveCash(amount) {
    if (run && typeof run.cash === 'number') { run.cash = round2(run.cash + amount); save('run', run) }
    checkDrop()
  }
  function checkDrop() {
    const limit = limits().cashDropThreshold
    const over = !!run && ((typeof run.cash === 'number' && limit > 0 && run.cash > limit) || serverDropDue)
    $('drop-alert').hidden = !over
  }

  // ------------------------------------------------------------ ringing up

  /** The staff member whose code is typed in the header box, or null. */
  const cashierNow = () => {
    const code = String($('cashier-code').value || '').trim().toUpperCase()
    return (cat && cat.staff || []).find((s) => s.c === code) || null
  }
  /** Nothing goes on a sale until the cashier has typed a valid code. */
  function needCode() {
    if (cashierNow()) return false
    const typed = String($('cashier-code').value || '').trim().toUpperCase()
    banner(!cat || !(cat.staff || []).length ? 'No staff codes are set up yet. A manager gives each person a 2-letter code under Users; then reload the till.'
      : typed ? `${esc(typed)} is not a staff code. Type your 2-letter cashier code first.` : 'Type your 2-letter cashier code in the box at the top before you start the sale.', true)
    $('cashier-code').focus(); $('cashier-code').select()
    return true
  }

  function addItem(it, packs = 1, units = null) {
    if (needCode()) return
    const n = it.n || 1
    const sign = cart.kind === 'refund' ? -1 : 1
    const u = sign * (units ?? Math.round(packs * n))
    if (cart.kind === 'refund' && cart.refundOf) { banner('This refund is for the items on the sale it reverses. Clear it to start again.', true); return }
    const existing = units === null && cart.lines.findIndex((l) => !l.sl && !l.rf && l.i === it.i && !l.adj && l.units % n === 0)
    if (existing !== false && existing >= 0) {
      const l = cart.lines[existing]
      l.units += u
      reprice(l); sel = existing
    } else {
      const l = { i: it.i, c: it.c, d: it.d, p: it.p, n, v: it.v ?? cat.tenant.vatRate ?? 0.14, units: u, listTotal: 0, lineTotal: 0, adj: null, approvalId: null }
      reprice(l)
      saveLines()
      cart.lines.push(l)
      sel = cart.lines.length - 1
    }
    render()
  }

  /** A line's list and charged totals from the basket engine. Refund lines are priced from the sale they reverse. */
  function reprice(l) {
    if (l.rf) {
      const t = -Math.min(round2(l.rf.amountLeft * (Math.abs(l.units) / l.rf.unitsLeft)), l.rf.amountLeft)
      l.listTotal = t; l.lineTotal = t
      return
    }
    const t = B.priceLine({ packPrice: l.p, packSize: l.n, units: l.units, adjust: l.adj })
    l.listTotal = t.listTotal; l.lineTotal = t.lineTotal
  }

  /** Lines already on the sale count as saved once another goes on after them; taking one off then needs a supervisor. */
  function saveLines() { for (const l of cart.lines) l.saved = true }

  /**
   * Take units off a line (all of it when units >= its quantity). The last line entered can be
   * corrected freely; a saved line, or any line once payment has started, needs a supervisor.
   * Every void is logged on the server. Refund lines can be reduced freely (that pays out less).
   */
  async function voidUnits(l, units) {
    const all = units >= Math.abs(l.units)
    const amount = all ? l.lineTotal : round2(l.lineTotal * (units / Math.abs(l.units)))
    let approval = null
    if (cart.kind === 'sale' && (l.saved || cart.tendering)) {
      approval = await approve('void', `Take ${all ? 'the line' : units + ' unit(s)'} ${esc(l.d)} (${money(amount)}) off this sale.`, { itemId: l.i, units, lineTotal: amount }, cart.id)
      if (!approval) return false
    }
    if (cart.kind === 'sale' && run) {
      queue({ type: 'till_event', data: { id: uuid(), runId: run.id, kind: 'void', reason: approval ? 'saved line' : 'correction',
        detail: { saleId: cart.id, itemId: l.i, description: l.d, units, lineTotal: amount }, approvalId: approval ? approval.id : null,
        cashierCode: (cashierNow() || {}).c || null, occurredAt: new Date().toISOString() } })
    }
    return true
  }

  function search(q) {
    const words = q.toUpperCase().split(/\s+/).filter(Boolean)
    if (!words.length || !cat) return []
    const out = []
    for (const it of cat.items) {
      const d = it.d.toUpperCase()
      if (words.every((w) => d.includes(w) || it.c.toUpperCase().startsWith(w))) {
        out.push(it)
        if (out.length >= 200) break
      }
    }
    out.sort((a, b) => (a.z || 0) - (b.z || 0) || (b.d.toUpperCase().startsWith(words[0]) - a.d.toUpperCase().startsWith(words[0])) || a.d.localeCompare(b.d))
    return out.slice(0, 15)
  }

  /** "3*6001234" sells 3 packs; "15u*CODE" sells 15 loose units. */
  function parseScan(raw) {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)(u?)\*(.+)$/i)
    if (!m) return { packs: 1, units: null, q: raw.trim() }
    return m[2] ? { packs: 1, units: Number(m[1]), q: m[3].trim() } : { packs: Number(m[1]), units: null, q: m[3].trim() }
  }

  async function onScanEnter() {
    const input = $('scan')
    const { packs, units, q } = parseScan(input.value)
    if (!q) { if (cart.lines.length) pay(); return }
    if (needCode()) return                  // nothing is entered until the cashier's code is in
    let it = byCode.get(q.toUpperCase())
    if (!it && results.length) it = results[resultSel]
    if (!it) { banner(`Nothing matches "${esc(q)}".`, true); input.select(); return }
    if (units !== null && !it.l && units % it.n !== 0) { banner(`${esc(it.d)} is only sold in whole packs of ${it.n}.`, true); return }
    if (!(await ensureRun())) return
    banner('')
    addItem(it, packs, units)
    input.value = ''
    results = []
    showResults()
  }

  const scriptLine = (l) => { if (l && l.sl) { banner('Script lines are priced in the dispensary. Press Del to take the whole script off this sale.', true); return true } return false }

  async function changeQty() {
    const l = cart.lines[sel]
    if (!l || scriptLine(l)) return
    const it = cat.items.find((x) => x.i === l.i) || { l: false }
    const v = await ask(`<h2>Quantity</h2><p>${esc(l.d)} <span class="muted">pack of ${l.n}</span></p>
      <label>Packs<input name="packs" inputmode="decimal" value="${l.units % l.n === 0 ? Math.abs(l.units / l.n) : ''}" autofocus></label>
      ${it.l && l.n > 1 ? `<label>or loose units<input name="units" inputmode="numeric" value="${l.units % l.n !== 0 ? Math.abs(l.units) : ''}"></label>` : ''}
      ${buttons()}`)
    if (!v) return
    const sign = cart.kind === 'refund' ? -1 : 1
    const units = v.units ? Math.round(num(v.units)) : Math.round(num(v.packs) * l.n)
    if (!(units > 0)) { banner('Enter a quantity above zero, or press Del to remove the line.', true); return }
    if (!it.l && units % l.n !== 0) { banner(`${esc(l.d)} is only sold in whole packs.`, true); return }
    if (!(await setUnits(l, units))) return
    render()
  }

  /** Change a line's quantity; fewer units than before is a void of the difference. */
  async function setUnits(l, units) {
    const sign = cart.kind === 'refund' ? -1 : 1
    if (l.rf && units > l.rf.unitsLeft) { banner(`Only ${l.rf.unitsLeft} unit(s) of ${esc(l.d)} are left to refund on that sale.`, true); return false }
    const fewer = Math.abs(l.units) - units
    if (fewer > 0 && !(await voidUnits(l, fewer))) return false
    l.units = sign * units
    reprice(l)
    return true
  }

  /**
   * Discount or change the price of a line. A discount up to the cashier's limit goes straight on;
   * a bigger one, or a price typed in, needs a supervisor. VAT is never typed: it follows the price.
   */
  async function changePrice() {
    const l = cart.lines[sel]
    if (!l || scriptLine(l)) return
    if (l.rf) { banner('A refund gives back what was paid on the sale it reverses.', true); return }
    const lim = limits().cashierDiscountPct
    const v = await ask(`<h2>Discount or change price</h2><p>${esc(l.d)}: list ${money(Math.abs(l.listTotal))} for this line (${money(l.p)} a pack)</p>
      <label>Discount %<input name="pct" inputmode="decimal" autofocus></label>
      <label>or amount off the line (P)<input name="off" inputmode="decimal"></label>
      <label>or new price per pack (P)<input name="price" inputmode="decimal"></label>
      <p class="muted">Up to ${lim}% off you can give yourself. More than that, or a new price, needs a supervisor.</p>
      <label class="row" style="flex-direction:row"><input type="checkbox" name="clear"> Back to the list price</label>${buttons()}`)
    if (!v) return
    let adj = null
    if (v.clear) adj = null
    else if (String(v.pct).trim()) {
      const pct = num(v.pct)
      if (!(pct > 0 && pct <= 100)) { banner('A discount is between 0 and 100%.', true); return }
      adj = { kind: 'discount', pct }
    } else if (String(v.off).trim()) {
      const off = num(v.off)
      if (!(off > 0) || off > Math.abs(l.listTotal)) { banner('The amount off must be more than zero and no more than the line.', true); return }
      adj = { kind: 'discount', pct: round2((off / Math.abs(l.listTotal)) * 10000) / 100 }
    } else if (String(v.price).trim()) {
      const packPrice = num(v.price)
      if (!(packPrice >= 0)) { banner('The price must be zero or more.', true); return }
      adj = packPrice === l.p ? null : { kind: 'override', packPrice }
    } else return
    const t = B.priceLine({ packPrice: l.p, packSize: l.n, units: l.units, adjust: adj })
    const needs = adj && B.approvalNeeded({ listTotal: t.listTotal, lineTotal: t.lineTotal, adjust: adj.kind }, lim)
    let approvalId = null
    if (needs === 'discount') {
      const a = await approve('discount', `${adj.pct}% off ${esc(l.d)}: ${money(Math.abs(t.lineTotal))} instead of ${money(Math.abs(t.listTotal))}.`, { itemId: l.i, pct: adj.pct }, cart.id)
      if (!a) return
      approvalId = a.id
    } else if (needs === 'price_override') {
      const a = await approve('price_override', `Sell ${esc(l.d)} at ${money(adj.packPrice)} a pack instead of ${money(l.p)}.`, { itemId: l.i, packPrice: adj.packPrice }, cart.id)
      if (!a) return
      approvalId = a.id
    }
    l.adj = adj
    l.approvalId = approvalId
    reprice(l)
    render()
  }

  async function bump(d) {
    const l = cart.lines[sel]
    if (!l || scriptLine(l)) return
    const next = Math.abs(l.units) + d * (l.rf ? 1 : l.n)
    if (next <= 0) { await removeLine(); return }
    if (!(await setUnits(l, next))) return
    render()
  }

  async function removeLine() {
    if (sel < 0 || !cart.lines[sel]) return
    const l = cart.lines[sel]
    if (l.sl) {
      // A script comes off whole. Its lines took no stock here, so this only takes the payment for it off the sale.
      const total = round2(cart.lines.filter((x) => x.sl).reduce((a, x) => a + x.lineTotal, 0))
      let a = null
      if (cart.kind === 'sale' && (l.saved || cart.tendering)) {
        a = await approve('void', `Take script ${esc(cart.script.scriptNo)} (${money(total)}) off this sale.`, { scriptId: cart.script.id, lineTotal: total }, cart.id)
        if (!a) return
      }
      if (cart.kind === 'sale' && run) {
        queue({ type: 'till_event', data: { id: uuid(), runId: run.id, kind: 'void', reason: a ? 'saved line' : 'correction',
          detail: { saleId: cart.id, scriptId: cart.script.id, description: `Script ${cart.script.scriptNo}`, lineTotal: total }, approvalId: a ? a.id : null,
          cashierCode: (cashierNow() || {}).c || null, occurredAt: new Date().toISOString() } })
      }
      cart.lines = cart.lines.filter((x) => !x.sl)
      cart.script = null
      sel = cart.lines.length - 1
      render()
      return
    }
    if (!(await voidUnits(l, Math.abs(l.units)))) return
    cart.lines.splice(sel, 1)
    sel = Math.min(sel, cart.lines.length - 1)
    render()
  }

  // ------------------------------------------------------------ scripts

  /** Bring a dispensed script onto the sale by its number. The stock left at dispensing, so these lines take none. */
  async function addScript() {
    if (needCode()) return
    if (cart.script) { banner('One script per sale. Finish this sale first.', true); return }
    if (cart.refundOf) { banner('This refund is for the sale it reverses. Clear it to refund a script instead.', true); return }
    if (!(await ensureRun())) return
    const v = await ask(`<h2>${cart.kind === 'refund' ? 'Refund a script' : 'Pay for a script'}</h2>
      <label>Script number<input name="no" inputmode="numeric" autofocus></label>${buttons('Find script')}`)
    if (!v || !String(v.no).trim()) return
    let sc
    try {
      const res = await fetch('/api/till/scripts/' + encodeURIComponent(String(v.no).trim()), { credentials: 'same-origin' })
      if (res.status === 404) { banner(`There is no script number ${esc(v.no)}.`, true); return }
      if (!res.ok) throw new Error()
      sc = await res.json()
      setOnline(true)
    } catch {
      setOnline(false)
      banner('Finding a script needs the server. Try again when the till is back online.', true)
      return
    }
    if (sc.status !== 'dispensed') { banner(`Script ${sc.scriptNo} is ${sc.status}, not dispensed.`, true); return }
    const refund = cart.kind === 'refund'
    if (!refund && sc.paid !== 0) {
      const ok = await ask(`<h2>Already paid?</h2><p>Script ${sc.scriptNo} has ${money(sc.paid)} rung up against it already.</p>${buttons('Ring it up again')}`)
      if (!ok) return
    }
    if (refund && sc.paid === 0) { banner(`Script ${sc.scriptNo} has not been paid at the till, so there is nothing to refund.`, true); return }
    const sign = refund ? -1 : 1
    cart.script = sc
    saveLines()
    for (const l of sc.lines) {
      cart.lines.push({ i: l.itemId, c: l.stockCode, d: l.description, p: round2(l.lineTotal / l.qtyUnits), n: 1, units: sign * l.qtyUnits,
        listTotal: sign * l.lineTotal, lineTotal: sign * l.lineTotal, vat: sign * l.vat, sl: l.scriptLineId })
    }
    sel = cart.lines.length - 1
    banner(`Script ${sc.scriptNo} for ${esc(sc.patientName)}${sc.medicalAid && sc.claimTotal ? `: ${money(sc.claimTotal)} to ${esc(sc.medicalAid)}, ${money(sc.patientTotal)} from the patient` : ''}.`)
    render()
  }

  // ------------------------------------------------------------ paying

  async function pay() {
    if (!cart.lines.length) return
    if (!(await ensureRun())) return
    // Every sale is rung under a cashier's 2-letter code, typed in the header box before anything is entered.
    if (needCode()) return
    const cashier = cashierNow()
    banner('')
    const { total } = totals()
    const refund = cart.kind === 'refund'
    const due = Math.abs(total)
    const lim = limits()
    if (refund) {
      // Every refund is allowed by a supervisor, for the amount being paid out.
      if (!cart.refundOf && !cart.script) { banner('A refund must be for a sale (F8 and its number) or a script (F2).', true); return }
      if (!cart.refundApproval || cart.refundApproval.total < due) {
        const a = await approve('refund', `Refund ${money(due)}${cart.refundRef ? ` on ${esc(cart.refundRef)}` : cart.script ? ` for script ${esc(cart.script.scriptNo)}` : ''}.`, { total: due, refundOf: cart.refundOf, scriptId: cart.script ? cart.script.id : null }, cart.id)
        if (!a) return
        cart.refundApproval = { id: a.id, total: due }
      }
    }
    cart.tendering = true                              // from here, taking a line off needs a supervisor
    const payments = []
    let accountId = null
    let medicalAid = null
    let memberNo = null
    let cashTendered = 0
    let rounding = 0                                  // cash rounding taken, in the same direction as `due`
    const sc = cart.script
    const order = refund ? ['cash', 'card', 'eft', 'account', ...(sc && sc.medicalAid ? ['medical_aid'] : [])] : ['cash', 'card', 'cheque', 'eft', 'account', 'medical_aid']
    const preferAccount = sc ? sc.accountId : null
    if (sc) {
      // The medical aid's share of a script is taken as its tender straight away; the patient pays the rest.
      const claim = Math.min(round2(sc.claimTotal), due)
      if (sc.medicalAid && claim > 0) {
        medicalAid = sc.medicalAid
        memberNo = sc.memberNo
        payments.push({ tender: 'medical_aid', amount: claim, reference: null })
      }
    }
    for (;;) {
      const paid = round2(payments.reduce((a, p) => a + p.amount, 0))
      const left = round2(due + rounding - paid)
      if (left <= 0 && payments.length) break
      if (due === 0) break
      const v = await ask(`<h2>${refund ? 'Refund' : 'Pay'} ${money(due)}</h2>
        ${payments.length ? `<table>${payments.map((p) => `<tr><td>${tenderNames[p.tender]}${p.reference ? ` <span class="muted">${esc(p.reference)}</span>` : ''}</td><td class="n">${money(p.amount)}</td></tr>`).join('')}<tr><td><b>Still to ${refund ? 'refund' : 'pay'}</b></td><td class="n"><b>${money(left)}</b></td></tr></table>` : ''}
        <div class="tenders">${order.map((t, i) => `<button type="button" data-t="${t}"><kbd>${i + 1}</kbd>${tenderNames[t]}</button>`).join('')}</div>
        <input type="hidden" name="tender" value="cash">
        <label>Amount (P)<input name="amount" class="amount" inputmode="decimal" value="${left.toFixed(2)}" autofocus></label>
        <div class="quick" data-quick></div>
        <p class="change" data-change></p>
        <div data-extra></div>
        <p class="err" data-err></p>${buttons(refund ? 'Refund' : 'Take payment')}`, (f) => {
        const showChange = () => {
          const out = f.querySelector('[data-change]')
          const a = round2(num(f.amount.value))
          const owed = f.tender.value === 'cash' ? roundCash(left) : left
          if (!(a > 0)) out.innerHTML = ''
          else if (a > owed && f.tender.value === 'cash' && !refund) out.innerHTML = round2(a - owed) > lim.maxChange ? `<span class="err">Change of ${money(round2(a - owed))} is more than the ${money(lim.maxChange)} limit. Check the amount.</span>` : `Change <b>${money(round2(a - owed))}</b>`
          else if (a < owed) out.innerHTML = `Still to ${refund ? 'refund' : 'pay'} after this: <b>${money(round2(owed - a))}</b>`
          else out.innerHTML = ''
        }
        // Cash notes a customer is likely to hand over, so a click takes the payment.
        const quick = (t) => {
          const q = f.querySelector('[data-quick]')
          if (t !== 'cash' || refund) { q.innerHTML = ''; return }
          const owed = roundCash(left)
          const notes = [...new Set([10, 20, 50, 100, 200].filter((v) => v > owed).slice(0, 3).concat(owed > 200 ? [Math.ceil(owed / 100) * 100] : []))]
            .filter((v) => v > owed)
          q.innerHTML = `<button type="button" class="secondary" data-amt="${owed}">Exact ${money(owed)}</button>` +
            notes.map((v) => `<button type="button" class="secondary" data-amt="${v}">${money(v)}</button>`).join('')
          q.querySelectorAll('[data-amt]').forEach((b) => (b.onclick = () => { f.amount.value = Number(b.dataset.amt).toFixed(2); f.requestSubmit() }))
        }
        f.amount.addEventListener('input', showChange)
        const pick = (t) => {
          f.tender.value = t
          f.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === t))
          const extra = f.querySelector('[data-extra]')
          if (t === 'account') extra.innerHTML = `<label>Account<select name="account">${(cat.accounts || []).map((a) => `<option value="${a.id}" ${a.id === (accountId || preferAccount) ? 'selected' : ''}>${esc(a.name)} (${esc(a.no)})</option>`).join('')}</select></label>`
          else if (t === 'medical_aid') extra.innerHTML = `<label>Medical aid<input name="aid" value="${esc(medicalAid || 'BOMAid')}"></label><label>Member number<input name="member" value="${esc(memberNo || '')}"></label>`
          else if (t === 'card' && lim.cardTerminal === 'integrated') extra.innerHTML = `<p class="muted">The card terminal will be asked for the payment.</p>`
          else if (t === 'card') extra.innerHTML = `<label>Approval code from the card machine slip<input name="ref" required autocomplete="off"></label>`
          else if (t === 'cheque' || t === 'eft') extra.innerHTML = `<label>Reference (optional)<input name="ref"></label>`
          else extra.innerHTML = ''
          const cashLeft = roundCash(left)
          if (t === 'cash' && cashLeft !== left) extra.innerHTML = `<p class="muted">Rounded to ${money(cashLeft)} for cash (was ${money(left)}).</p>`
          f.amount.value = (t === 'cash' ? cashLeft : left).toFixed(2)
          f.amount.focus(); f.amount.select()
          quick(t)
          showChange()
        }
        f.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => pick(b.dataset.t)))
        f.addEventListener('keydown', (e) => {
          const n = Number(e.key)
          if (e.altKey || e.ctrlKey || !(n >= 1 && n <= order.length)) return
          if (e.target === f.amount && f.amount.value !== '' && f.amount.selectionStart === f.amount.selectionEnd) return
          e.preventDefault(); pick(order[n - 1])
        })
        pick('cash')
      })
      if (!v) return
      let amount = round2(num(v.amount))
      if (!(amount > 0)) { banner('Enter an amount above zero.', true); continue }
      if (v.tender === 'account') {
        if (!v.account) { banner('There are no customer accounts. Add one in the back office first.', true); continue }
        if (accountId && accountId !== v.account) { banner('One sale can go on one account only.', true); continue }
        const a = cat.accounts.find((x) => x.id === v.account)
        const owes = round2((a ? a.balance : 0) + accountMovesFor(v.account))
        if (a && a.limit !== null && !refund && owes + amount > a.limit + 0.001) {
          banner(`${esc(a.name)} would go over the credit limit: owes ${money(owes)}, limit ${money(a.limit)}.`, true); continue
        }
        accountId = v.account
      }
      if (v.tender === 'medical_aid') { medicalAid = (v.aid || '').trim(); memberNo = (v.member || '').trim(); if (!medicalAid) { banner('Enter the medical aid name.', true); continue } }
      let gateway = null
      if (v.tender === 'card') {
        if (amount > left) { banner(`Only ${money(left)} is left to ${refund ? 'refund' : 'pay'}.`, true); continue }
        if (lim.cardTerminal === 'integrated') {
          // A linked terminal must hand back a transaction token before the payment counts. No terminal driver ships with sylken yet.
          const term = window.SylkenCardTerminal
          if (!term || typeof term.charge !== 'function') { banner('No card terminal is linked to this till yet. A manager can set Settings, Card machine, back to a separate machine.', true); continue }
          try {
            gateway = await term.charge({ amount, saleId: cart.id, refund })
          } catch (e) { banner('The card terminal did not approve the payment: ' + esc(e && e.message ? e.message : 'no answer'), true); continue }
          if (!gateway || !/^[A-Za-z0-9._:\-]{6,128}$/.test(String(gateway.token || ''))) { banner('The card terminal did not send back a transaction token, so the payment is not counted.', true); continue }
        } else if (!String(v.ref || '').trim()) { banner('Type the approval code printed on the card machine slip.', true); continue }
      }
      const cashLeft = roundCash(left)
      if (v.tender === 'cash' && !refund && amount > cashLeft && B.cashChange(amount, cashLeft, lim.maxChange).tooMuch) {
        banner(`Change of ${money(round2(amount - cashLeft))} is more than the ${money(lim.maxChange)} limit. Check the amount typed.`, true); continue
      }
      if (v.tender === 'cash' && amount >= cashLeft && (!refund || amount === cashLeft)) {
        // This cash settles the sale: what's due is rounded to the coin, anything over is change.
        if (!refund) cashTendered = round2(cashTendered + amount)
        rounding = round2(rounding + cashLeft - left)
        amount = cashLeft
      } else if (v.tender === 'cash' && !refund) {
        cashTendered = round2(cashTendered + amount)
      } else if (amount > left) { banner(`Only ${money(left)} is left to ${refund ? 'refund' : 'pay'}; only cash can be more, for change.`, true); continue }
      banner('')
      const existing = !gateway && payments.find((p) => p.tender === v.tender && !v.ref && !p.reference && !p.gatewayToken)
      if (existing) existing.amount = round2(existing.amount + amount)
      else payments.push({ tender: v.tender, amount, reference: v.ref || null, ...(gateway ? { gatewayToken: String(gateway.token), gatewayPayload: gateway.payload || null } : {}) })
    }
    const sign = refund ? -1 : 1
    const cashPaid = round2(payments.filter((p) => p.tender === 'cash').reduce((a, p) => a + p.amount, 0))
    const change = refund ? 0 : round2(cashTendered - cashPaid)
    const sale = {
      id: cart.id, runId: run.id, kind: cart.kind, refundOf: cart.refundOf, refundApprovalId: cart.refundApproval ? cart.refundApproval.id : null,
      occurredAt: new Date().toISOString(), cashierCode: cashier.c,
      accountId, medicalAid, memberNo, cashTendered: cashPaid > 0 && !refund ? cashTendered : null, rounding: round2(sign * rounding),
      scriptId: cart.script ? cart.script.id : null,
      lines: cart.lines.map((l) => ({ itemId: l.i, qtyUnits: l.units, listTotal: l.listTotal, lineTotal: l.lineTotal, scriptLineId: l.sl || null,
        adjust: l.adj ? l.adj.kind : null, approvalId: l.approvalId || null })),
      payments: payments.map((p) => ({ ...p, amount: round2(sign * p.amount) })),
    }
    queue({ type: 'sale', data: sale })
    const slipNo = (load('slipNo', 0) || 0) + 1
    save('slipNo', slipNo)
    const onAccount = round2(payments.filter((p) => p.tender === 'account').reduce((a, p) => a + p.amount, 0))
    if (accountId && onAccount) noteAccountMove(sale.id, accountId, sign * onAccount)
    lastSlip = { sale, slipNo, ref: slipRef(sale.id), refundRef: cart.refundRef, lines: cart.lines.map((l) => ({ d: l.d, units: l.units, n: l.n, lineTotal: l.lineTotal, v: l.v, vat: l.vat })), change, cashier: `${cashier.n} (${cashier.c})`, at: sale.occurredAt,
      script: cart.script ? { no: cart.script.scriptNo, patient: cart.script.patientName } : null }
    save('lastSlip', lastSlip)
    const last = $('last')
    last.hidden = false
    const settled = round2(due + rounding)
    last.className = 'last' + (change > 0 ? ' change' : '')
    last.innerHTML = refund ? `<span>Refunded</span><b>${money(settled)}</b>`
      : change > 0 ? `<span>Give change</span><b>${money(change)}</b><small>${money(cashTendered)} cash for ${money(settled)}</small>`
      : `<span>Paid</span><b>${money(settled)}</b><small>${payments.map((p) => tenderNames[p.tender]).join(' + ')}</small>`
    for (const l of cart.lines) { const it = !l.sl && cat.items.find((x) => x.i === l.i); if (it && it.s !== undefined) it.s -= l.units }
    if (cashPaid !== 0) { openDrawer(refund ? 'cash_refund' : 'cash_sale'); moveCash(sign * cashPaid) }
    $('cashier-code').value = ''          // the next sale needs its own code
    showCashier()
    $('scan').value = ''
    setTimeout(() => $('cashier-code').focus(), 0)
    results = []
    showResults()
    cart = newCart()
    sel = -1
    render()
    sync()
  }

  // ------------------------------------------------------------ other drawer entries

  /** Petty cash out of the drawer is a cash payout, so a supervisor allows it. */
  async function pettyCash() {
    if (!(await ensureRun())) return
    const v = await ask(`<h2>Petty cash out of the drawer</h2>
      <label>Amount (P)<input name="amount" inputmode="decimal" autofocus></label>
      <label>What for<input name="note" required maxlength="200"></label>${buttons('Next')}`)
    if (!v) return
    const amount = round2(num(v.amount))
    if (!(amount > 0) || !v.note.trim()) { banner('Petty cash needs an amount and what it was for.', true); return }
    const id = uuid()
    const a = await approve('petty_cash', `Pay ${money(amount)} petty cash out of the drawer: ${esc(v.note.trim())}.`, { amount, note: v.note.trim() }, id)
    if (!a) return
    queue({ type: 'till_entry', data: { id, runId: run.id, kind: 'petty_cash', tender: 'cash', amount, note: v.note.trim(), approvalId: a.id, occurredAt: new Date().toISOString() } })
    moveCash(-amount)
    banner(`Petty cash ${money(amount)} recorded, allowed by ${esc(a.name)}.`)
    sync()
  }

  /** Cash taken out of the drawer to a supervisor or the safe. The supervisor taking it types their code and PIN. */
  async function cashDrop() {
    if (!(await ensureRun())) return
    const v = await ask(`<h2>Cash drop</h2><p>Count the cash going to the safe or the supervisor.</p>
      <label>Amount (P)<input name="amount" inputmode="decimal" autofocus></label>${buttons('Next')}`)
    if (!v) return
    const amount = round2(num(v.amount))
    if (!(amount > 0)) { banner('Enter the amount being taken out.', true); return }
    const id = uuid()
    const a = await approve('cash_drop', `Take ${money(amount)} out of the drawer. The supervisor receiving it confirms.`, { amount }, id)
    if (!a) return
    queue({ type: 'till_entry', data: { id, runId: run.id, kind: 'cash_drop', tender: 'cash', amount, note: `received by ${a.name}`, approvalId: a.id, occurredAt: new Date().toISOString() } })
    openDrawer('cash_drop')
    serverDropDue = false
    moveCash(-amount)
    banner(`Cash drop of ${money(amount)} recorded, received by ${esc(a.name)}.`)
    sync()
  }

  /** Open the drawer with no sale: a reason, a supervisor, and a high-priority entry in the log. */
  async function noSale() {
    if (needCode()) return
    if (!(await ensureRun())) return
    const reasons = (cat && cat.noSaleReasons) || ['Other']
    const v = await ask(`<h2>No sale: open the drawer</h2>
      <label>Reason<select name="reason" autofocus>${reasons.map((r) => `<option>${esc(r)}</option>`).join('')}</select></label>
      <label>Note<input name="note" maxlength="150" placeholder="Needed when the reason is Other"></label>${buttons('Next')}`)
    if (!v) return
    const reason = v.reason === 'Other' || !v.reason ? String(v.note || '').trim() : `${v.reason}${String(v.note || '').trim() ? ': ' + String(v.note).trim() : ''}`
    if (!reason) { banner('Say why the drawer is being opened.', true); return }
    const id = uuid()
    const a = await approve('no_sale', `Open the drawer with no sale: ${esc(reason)}.`, { reason }, id)
    if (!a) return
    queue({ type: 'till_event', data: { id, runId: run.id, kind: 'no_sale', reason, approvalId: a.id, cashierCode: cashierNow().c, occurredAt: new Date().toISOString() } })
    openDrawer('no_sale')
    banner(`No-sale recorded, allowed by ${esc(a.name)}.`)
    sync()
  }

  async function accountPayment() {
    if (!(await ensureRun())) return
    if (!cat.accounts || !cat.accounts.length) { banner('There are no customer accounts yet. Add them in the back office.', true); return }
    const v = await ask(`<h2>Payment on an account</h2>
      <label>Account<select name="account" autofocus>${cat.accounts.map((a) => `<option value="${a.id}">${esc(a.name)} (${esc(a.no)})</option>`).join('')}</select></label>
      <label>Amount (P)<input name="amount" inputmode="decimal"></label>
      <label>Paid by<select name="tender"><option value="cash">Cash</option><option value="card">Card</option><option value="cheque">Cheque</option><option value="eft">EFT</option></select></label>
      ${buttons('Record payment')}`)
    if (!v) return
    const amount = round2(num(v.amount))
    if (!(amount > 0)) { banner('Enter an amount above zero.', true); return }
    const entryId = uuid()
    queue({ type: 'till_entry', data: { id: entryId, runId: run.id, kind: 'account_payment', tender: v.tender, amount, accountId: v.account, occurredAt: new Date().toISOString() } })
    noteAccountMove(entryId, v.account, -amount)
    if (v.tender === 'cash') moveCash(amount)
    const a = cat.accounts.find((x) => x.id === v.account)
    banner(`${money(amount)} received from ${esc(a ? a.name : 'account')}.`)
    sync()
  }

  // ------------------------------------------------------------ slip

  function printSlip() {
    if (!lastSlip) { banner('No sale to reprint yet.'); return }
    const s = lastSlip
    const t = cat && cat.tenant
    const till = cat && cat.tills.find((x) => x.id === tillId)
    const total = round2(s.lines.reduce((a, l) => a + l.lineTotal, 0))
    $('slip').innerHTML = `<h3>${esc(t ? t.name : boot.tenantName)}</h3>
      ${t && t.vatNumber ? `<div class="c">VAT no ${esc(t.vatNumber)}</div>` : ''}
      <div class="c">${s.sale.kind === 'refund' ? 'REFUND' : 'TAX INVOICE'}</div>
      <div>${new Date(s.at).toLocaleString('en-GB')} · ${esc(till ? till.code : '')}-${s.slipNo} · ${esc(s.cashier)}</div>
      <div>Ref ${esc(s.ref || slipRef(s.sale.id))}${s.refundRef ? ` · refund of ${esc(s.refundRef)}` : ''}</div>
      ${s.script ? `<div>Script ${esc(s.script.no)} · ${esc(s.script.patient)}</div>` : ''}
      ${s.sale.medicalAid ? `<div>${esc(s.sale.medicalAid)} ${esc(s.sale.memberNo || '')}</div>` : ''}<hr>
      <table>${s.lines.map((l) => `<tr><td>${esc(l.d)}<br>${l.units % l.n === 0 ? l.units / l.n : l.units + '/' + l.n}</td><td class="n">${money(l.lineTotal)}</td></tr>`).join('')}</table><hr>
      <table><tr><td><b>Total incl VAT</b></td><td class="n"><b>${money(total)}</b></td></tr>
      <tr><td>VAT included</td><td class="n">${money(round2(s.lines.reduce((a, l) => a + (l.vat ?? vatIn(l.lineTotal, l.v ?? 0.14)), 0)))}</td></tr>
      ${s.sale.rounding ? `<tr><td>Cash rounding</td><td class="n">${money(s.sale.rounding)}</td></tr><tr><td><b>Paid</b></td><td class="n"><b>${money(round2(total + s.sale.rounding))}</b></td></tr>` : ''}
      ${s.sale.payments.map((p) => `<tr><td>${tenderNames[p.tender]}</td><td class="n">${money(p.tender === 'cash' && s.change ? p.amount + s.change : p.amount)}</td></tr>`).join('')}
      ${s.change ? `<tr><td>Change</td><td class="n">${money(s.change)}</td></tr>` : ''}</table>
      ${t && t.receiptFooter ? `<hr><div class="c">${esc(t.receiptFooter)}</div>` : ''}`
    window.print()
  }

  // ------------------------------------------------------------ account balances between item-list refreshes

  // Account charges and payments made on this till that the last item list doesn't include yet,
  // so the credit limit check sees them. Dropped once a refresh started after they reached the server.
  let accountMoves = load('accountMoves', [])
  function noteAccountMove(id, accountId, amount) { accountMoves.push({ id, accountId, amount }); save('accountMoves', accountMoves) }
  function accountMovesFor(accountId) { return accountMoves.filter((m) => m.accountId === accountId).reduce((a, m) => a + m.amount, 0) }

  // ------------------------------------------------------------ sync

  function queue(op) {
    op.userId = user.id
    outbox.push(op)
    save('outbox', outbox)
    header()
  }

  let syncing = false
  async function sync() {
    if (syncing || !tillId) return
    syncing = true
    try {
      const batch = outbox.slice(0, 100)
      const res = await fetch('/api/till/sync', {
        // Polling with nothing to send is not activity, so it doesn't keep an idle login alive.
        method: 'POST', headers: { 'content-type': 'application/json', 'x-sylken-background': batch.length ? '0' : '1' }, credentials: 'same-origin',
        body: JSON.stringify({ tillId, deviceId, pending: outbox.length, runIds: run ? [run.id] : [], ops: batch }),
      })
      if (res.status === 401) { setOnline(true); banner('Your login has expired. <a href="/login">Log in again</a>; sales rung up meanwhile are kept on this till.', true); return }
      if (!res.ok) throw new Error('server ' + res.status)
      const body = await res.json()
      setOnline(true)
      const done = new Set()
      for (const r of body.results) {
        const op = batch.find((o) => o.data.id === r.id)
        if (!op) continue
        done.add(op)
        const move = accountMoves.find((m) => m.id === r.id)
        if (move && !move.syncedAt) move.syncedAt = Date.now()
        if (r.status === 'rejected') failed.push({ op, error: r.error, at: new Date().toISOString() })
      }
      outbox = outbox.filter((o) => !done.has(o))
      save('outbox', outbox)
      save('failed', failed)
      save('accountMoves', accountMoves)
      serverDropDue = !!body.cashDropDue
      checkDrop()
      if (run && body.runs[run.id]) {
        run.runNo = body.runs[run.id].runNo
        if (body.runs[run.id].status === 'closed') {
          banner(`Run ${run.runNo} has been cashed up. The next sale opens a new run.`)
          run = null
          serverDropDue = false
        }
        save('run', run)
      }
      header()
      if (outbox.length && done.size) setTimeout(sync, 200)
    } catch {
      setOnline(false)
    } finally {
      syncing = false
    }
  }

  async function refreshCatalogue() {
    const started = Date.now()
    try {
      const res = await fetch('/api/till/catalogue', { credentials: 'same-origin', headers: { 'x-sylken-background': '1' } })
      if (res.status === 401) { banner('Your login has expired. <a href="/login">Log in again</a>.', true); return }
      if (!res.ok) throw new Error()
      cat = await res.json()
      accountMoves = accountMoves.filter((m) => !(m.syncedAt && m.syncedAt < started))
      save('accountMoves', accountMoves)
      user = cat.user
      save('catalogue', cat)
      index()
      quickButtons()
      setOnline(true)
      if (tillId && !cat.tills.some((t) => t.id === tillId)) { tillId = null; save('till', null) }
      header()
    } catch {
      setOnline(false)
      if (!cat) banner('The till needs to reach the server once to load the item list.', true)
    }
  }

  function setOnline(v) { online = v; header() }

  async function clearSale() {
    if (!cart.lines.length) {
      if (cart.kind === 'refund') { cart = newCart('sale'); render() }
      return
    }
    const v = await ask(`<h2>Clear this ${cart.kind}?</h2><p>${cart.lines.length} line(s), ${money(totals().total)}</p>${buttons('Clear')}`)
    if (!v) return
    if (cart.kind === 'sale') {
      const saved = cart.lines.filter((l) => l.saved || cart.tendering)
      let approval = null
      if (saved.length) {
        approval = await approve('void', `Clear the whole sale: ${cart.lines.length} line(s), ${money(totals().total)}.`, { lines: cart.lines.length, lineTotal: totals().total }, cart.id)
        if (!approval) return
      }
      if (run) {
        for (const l of cart.lines) {
          queue({ type: 'till_event', data: { id: uuid(), runId: run.id, kind: 'void', reason: approval ? 'sale cleared' : 'correction',
            detail: { saleId: cart.id, itemId: l.i, description: l.d, units: Math.abs(l.units), lineTotal: l.lineTotal }, approvalId: approval ? approval.id : null,
            cashierCode: (cashierNow() || {}).c || null, occurredAt: new Date().toISOString() } })
        }
      }
    }
    cart = newCart('sale'); sel = -1; render()
  }

  // ------------------------------------------------------------ touch screen layout

  // Big buttons for a touch screen: the shop's quick-sale items, a number pad and the main
  // actions. A number typed on the pad before an item button sells that many packs.
  let touch = load('touch', null)
  if (touch === null) touch = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches)

  function setTouch(v) {
    touch = v
    save('touch', v)
    document.body.classList.toggle('touch-mode', v)
    $('touch-toggle').textContent = v ? 'Keyboard layout' : 'Touch screen'
    $('scan').inputMode = v ? 'none' : 'text'
    quickButtons()
  }

  function quickButtons() {
    const list = (cat && cat.tenant.buttons) || []
    $('quick').innerHTML = list.length
      ? list.map((b, i) => { const it = byCode.get(b.code.toUpperCase()); return `<button type="button" class="qi c-${esc(b.color)}" data-q="${i}" ${it ? '' : 'disabled'}>${esc(b.label)}${it ? `<small>${money(it.p)}</small>` : ''}</button>` }).join('')
      : '<p class="muted">No quick buttons yet. The owner adds them in the back office under Settings.</p>'
  }

  /** A whole number typed on the pad, or null. */
  function padNumber() { const v = $('scan').value.trim(); return /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? Number(v) : null }

  async function quickSale(i) {
    const b = cat.tenant.buttons[i]
    const it = b && byCode.get(b.code.toUpperCase())
    if (!it) return
    const packs = padNumber() || 1
    if (!(await ensureRun())) return
    banner('')
    addItem(it, packs)
    $('scan').value = ''
    results = []
    showResults()
  }

  async function setQtyFromPad() {
    const n = padNumber()
    const l = cart.lines[sel]
    if (n === null || !l) { changeQty(); return }
    if (scriptLine(l)) return
    const units = Math.round(n * l.n)
    const it = cat.items.find((x) => x.i === l.i) || { l: false }
    if (!it.l && units % l.n !== 0) { banner(`${esc(l.d)} is only sold in whole packs.`, true); return }
    $('scan').value = ''
    if (!(await setUnits(l, units))) return
    render()
  }

  $('touch-toggle').addEventListener('click', () => setTouch(!touch))
  $('quick').addEventListener('click', async (e) => { const b = e.target.closest('[data-q]'); if (b) { await quickSale(Number(b.dataset.q)); $('scan').focus({ preventScroll: true }) } })
  document.querySelector('.pad').addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b || modalDone) return
    const scan = $('scan')
    const k = b.dataset.k
    if (k === 'C') { scan.value = ''; results = []; showResults() }
    else if (k === 'enter') onScanEnter()
    else if (k) scan.value += k
    const actions = { qty: setQtyFromPad, price: changePrice, void: removeLine, voidall: clearSale, script: addScript, refund: toggleRefund, reprint: printSlip, pay,
      nosale: noSale, drop: cashDrop, petty: pettyCash }
    if (b.dataset.a) actions[b.dataset.a]()
    if (!modalDone) scan.focus({ preventScroll: true })   // a scanner always types into the sale
  })

  // ------------------------------------------------------------ keys

  /**
   * Refund mode. A refund always points at the sale it reverses: type its number or the reference on
   * the slip, and its lines come onto the refund (take off what is not coming back). A script is
   * refunded with F2 instead. A supervisor allows the refund when it is paid out.
   */
  async function toggleRefund() {
    if (cart.lines.length) { banner('Finish or clear this sale before switching between sale and refund.', true); return }
    if (cart.kind === 'refund') { cart = newCart('sale'); render(); return }
    if (needCode()) return
    if (!(await ensureRun())) return
    const v = await ask(`<h2>Refund</h2><p>Which sale is being refunded?</p>
      <label>Sale number, or the reference on the slip<input name="ref" autocomplete="off" autofocus></label>
      <p class="muted">For a script, leave this empty and press F2 Script after switching to refund.</p>${buttons('Find sale')}`)
    if (!v) return
    const ref = String(v.ref || '').trim()
    if (!ref) { cart = newCart('refund'); render(); banner('Refund mode: press F2 to bring in the script being refunded.'); return }
    let sale
    try {
      const res = await fetch('/api/till/sales/' + encodeURIComponent(ref), { credentials: 'same-origin' })
      setOnline(true)
      if (res.status === 404) { banner(`There is no sale ${esc(ref)}.`, true); return }
      if (!res.ok) throw new Error()
      sale = await res.json()
    } catch {
      setOnline(false)
      banner('Finding the sale to refund needs the server. Try again when the till is back online.', true)
      return
    }
    if (sale.scriptId) { banner(`Sale ${sale.saleNo} paid for a script. Leave the number empty and press F2 to refund the script.`, true); return }
    const left = sale.lines.filter((l) => l.unitsLeft > 0)
    if (!left.length) { banner(`Everything on sale ${sale.saleNo} has already been refunded.`, true); return }
    cart = newCart('refund')
    cart.refundOf = sale.id
    cart.refundRef = `sale ${sale.saleNo}`
    for (const l of left) {
      const line = { i: l.itemId, c: l.stockCode, d: l.description, p: round2(l.lineTotal / l.qtyUnits * l.packSize), n: l.packSize, v: l.vatRate, units: -l.unitsLeft,
        listTotal: 0, lineTotal: 0, adj: null, approvalId: null, rf: { unitsLeft: l.unitsLeft, amountLeft: l.amountLeft } }
      reprice(line)
      cart.lines.push(line)
    }
    sel = cart.lines.length - 1
    banner(`Refunding sale ${sale.saleNo} of ${esc(new Date(sale.occurredAt).toLocaleString('en-GB'))}. Take off anything not coming back, then pay out.`)
    render()
  }

  document.addEventListener('keydown', async (e) => {
    if (modalDone) { if (e.key === 'Escape') { e.preventDefault(); modalDone(null) } return }
    const scan = $('scan')
    const inScan = e.target === scan
    const inCode = e.target === $('cashier-code')
    const k = e.key
    const fkeys = { F2: addScript, F3: cashDrop, F4: changeQty, F5: pay, F6: changePrice, F7: noSale, F8: toggleRefund, F9: pettyCash, F10: accountPayment, F12: printSlip }
    if (fkeys[k]) { e.preventDefault(); fkeys[k](); return }
    if (k === 'Escape') {
      e.preventDefault()
      if (results.length) { results = []; showResults(); scan.value = ''; return }
      clearSale()
      return
    }
    if (inCode) return                      // typing the cashier code: leave every other key alone
    if (inScan && results.length && (k === 'ArrowDown' || k === 'ArrowUp')) {
      e.preventDefault()
      resultSel = Math.max(0, Math.min(results.length - 1, resultSel + (k === 'ArrowDown' ? 1 : -1)))
      showResults(); return
    }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      if (!cart.lines.length) return
      e.preventDefault()
      sel = Math.max(0, Math.min(cart.lines.length - 1, (sel < 0 ? cart.lines.length : sel) + (k === 'ArrowDown' ? 1 : -1)))
      render(); return
    }
    if (inScan && k === 'Enter') { e.preventDefault(); onScanEnter(); return }
    if ((k === '+' || k === '-') && (!inScan || scan.value === '')) { e.preventDefault(); bump(k === '+' ? 1 : -1); return }
    if (k === 'Delete' && (!inScan || scan.value === '')) { e.preventDefault(); removeLine(); return }
    if (!inScan && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) scan.focus()
  })

  $('scan').addEventListener('input', (e) => {
    const { q } = parseScan(e.target.value)
    results = q.length >= 2 && !byCode.has(q.toUpperCase()) ? search(q) : []
    resultSel = 0
    showResults()
  })
  $('results').addEventListener('click', (e) => {
    const li = e.target.closest('li')
    if (!li) return
    resultSel = Number(li.dataset.i)
    onScanEnter()
  })
  $('lines').addEventListener('click', (e) => {
    const tr = e.target.closest('tr')
    if (tr) { sel = Number(tr.dataset.i); render(); $('scan').focus() }
  })
  window.addEventListener('online', () => { setOnline(true); sync() })
  window.addEventListener('offline', () => setOnline(false))
  window.addEventListener('beforeunload', (e) => { if (cart.lines.length) { e.preventDefault(); e.returnValue = '' } })

  // ------------------------------------------------------------ start

  index()
  setTouch(touch)
  checkDrop()
  $('cashier-code').focus()               // every sale starts with the cashier's code
  render()
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/till/sw.js', { scope: '/till/' }).catch(() => {})
  ;(async () => {
    await refreshCatalogue()
    if (!tillId && cat) await chooseTill()
    header()
    sync()
    setInterval(sync, 15_000)
    setInterval(refreshCatalogue, 10 * 60_000)
  })()
})()
