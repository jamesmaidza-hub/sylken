// sylken till. Runs in the browser and keeps working offline: the item list, the open run and
// every sale it rings up live in localStorage, and an outbox of recorded operations is sent to
// /api/till/sync whenever the server can be reached. Each operation carries an id made here,
// so sending one twice records it once.
;(() => {
  'use strict'
  const boot = window.SYLKEN
  const key = (k) => `sylken:${boot.tenantId}:${k}`
  const load = (k, d) => { try { const v = localStorage.getItem(key(k)); return v === null ? d : JSON.parse(v) } catch { return d } }
  const save = (k, v) => { try { localStorage.setItem(key(k), JSON.stringify(v)) } catch (e) { banner('This browser could not save the till data: ' + e.message, true) } }
  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
  const money = (n) => (n < 0 ? '-' : '') + 'P' + Math.abs(n).toLocaleString('en-BW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID()
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  // Same rule as the server: a line is its units as a fraction of the pack price, so whole packs are exact.
  const linePrice = (packPrice, packSize, units) => round2((units / packSize) * packPrice)
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

  function newCart(kind = 'sale') { return { kind, lines: [], refundOf: null } }

  function index() {
    byCode = new Map()
    if (!cat) return
    for (const it of cat.items) {
      byCode.set(it.c.toUpperCase(), it)
      for (const b of it.b || []) byCode.set(b.toUpperCase(), it)
    }
  }

  // ------------------------------------------------------------ screen

  function banner(text, bad) {
    const b = $('banner')
    b.hidden = !text
    b.className = 'banner' + (bad ? ' bad' : '')
    b.innerHTML = text || ''
  }

  function header() {
    const t = cat && cat.tills.find((x) => x.id === tillId)
    $('till-label').textContent = t ? `${t.name} (${t.code})` : 'No till chosen'
    $('run-label').textContent = run ? (run.runNo ? `Run ${run.runNo}` : 'Run (not sent yet)') : 'No run open'
    $('cashier').textContent = user.name
    const net = $('net')
    net.textContent = online ? 'Online' : 'Offline: sales are kept on this till'
    net.className = 'net ' + (online ? 'on' : 'off')
    $('pending').textContent = outbox.length ? `${outbox.length} waiting to send` : ''
    const f = $('failed')
    f.hidden = !failed.length
    f.innerHTML = failed.length ? `<b>${failed.length} not accepted by the server.</b> They are kept on the server's list of till problems for the back office to sort out.<br><button class="secondary" id="clear-failed" type="button">Hide</button>` : ''
    if (failed.length) $('clear-failed').onclick = () => { failed = []; save('failed', failed); header() }
  }

  function totals() {
    const total = round2(cart.lines.reduce((a, l) => a + l.lineTotal, 0))
    return { total }
  }

  function render() {
    const tb = $('lines')
    tb.innerHTML = cart.lines.map((l, i) => {
      const changed = l.lineTotal !== l.listTotal
      const qty = l.units % l.n === 0 ? String(l.units / l.n) : `${l.units}/${l.n}`
      return `<tr class="${i === sel ? 'sel' : ''}" data-i="${i}"><td>${esc(l.d)} <span class="code">${esc(l.c)}</span></td>
        <td class="n">${qty}</td><td class="n">${money(l.p)}</td>
        <td class="n">${changed ? `<span class="was">${money(l.listTotal)}</span>` : ''}${money(l.lineTotal)}</td></tr>`
    }).join('')
    $('empty').hidden = cart.lines.length > 0
    const { total } = totals()
    $('total').textContent = money(total)
    $('due-label').textContent = cart.kind === 'refund' ? 'To refund' : 'To pay'
    document.querySelector('.due').classList.toggle('refund', cart.kind === 'refund')
    $('mode').hidden = cart.kind !== 'refund'
    header()
  }

  function showResults() {
    const ul = $('results')
    ul.hidden = !results.length
    ul.innerHTML = results.map((it, i) => `<li class="${i === resultSel ? 'sel' : ''}" data-i="${i}"><span class="code">${esc(it.c)}</span>
      <span>${esc(it.d)}${it.z ? ' <span class="muted">(dormant)</span>' : ''}</span><span class="price">${money(it.p)}${it.n > 1 ? ` <span class="muted">/ ${it.n}</span>` : ''}</span></li>`).join('')
  }

  // ------------------------------------------------------------ modal forms

  let modalDone = null
  function ask(html, onOpen) {
    return new Promise((resolve) => {
      const m = $('modal')
      const f = $('modal-form')
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
    const def = cat ? cat.tenant.defaultFloat : 0
    const v = await ask(`<h2>Open a till run</h2><p class="muted">Count the float in the drawer before the first sale.</p>
      <label>Opening float (P)<input name="float" inputmode="decimal" value="${def.toFixed(2)}" autofocus></label>${buttons('Open run')}`)
    if (!v) return false
    const float = num(v.float)
    if (!(float >= 0)) { banner('The float must be a number.', true); return false }
    run = { id: uuid(), tillId, openedAt: new Date().toISOString(), float }
    save('run', run)
    queue({ type: 'open_run', data: { id: run.id, tillId, openingFloat: float, openedAt: run.openedAt } })
    header()
    return true
  }

  // ------------------------------------------------------------ ringing up

  function addItem(it, packs = 1, units = null) {
    const n = it.n || 1
    const sign = cart.kind === 'refund' ? -1 : 1
    const u = sign * (units ?? Math.round(packs * n))
    const existing = units === null && cart.lines.findIndex((l) => l.i === it.i && l.lineTotal === l.listTotal && l.units % n === 0)
    if (existing !== false && existing >= 0) {
      const l = cart.lines[existing]
      l.units += u
      if (l.units === 0) { cart.lines.splice(existing, 1); sel = Math.min(sel, cart.lines.length - 1) } else { reprice(l); sel = existing }
    } else {
      const l = { i: it.i, c: it.c, d: it.d, p: it.p, n, units: u, listTotal: 0, lineTotal: 0 }
      reprice(l)
      cart.lines.push(l)
      sel = cart.lines.length - 1
    }
    render()
  }

  function reprice(l) { l.listTotal = linePrice(l.p, l.n, l.units); l.lineTotal = l.listTotal }

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
    out.sort((a, b) => (b.d.toUpperCase().startsWith(words[0]) - a.d.toUpperCase().startsWith(words[0])) || (a.z || 0) - (b.z || 0) || a.d.localeCompare(b.d))
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
    if (!(await ensureRun())) return
    let it = byCode.get(q.toUpperCase())
    if (!it && results.length) it = results[resultSel]
    if (!it) { banner(`Nothing matches "${esc(q)}".`, true); input.select(); return }
    if (units !== null && !it.l && units % it.n !== 0) { banner(`${esc(it.d)} is only sold in whole packs of ${it.n}.`, true); return }
    banner('')
    addItem(it, packs, units)
    input.value = ''
    results = []
    showResults()
  }

  async function changeQty() {
    const l = cart.lines[sel]
    if (!l) return
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
    l.units = sign * units
    reprice(l)
    render()
  }

  async function changePrice() {
    const l = cart.lines[sel]
    if (!l) return
    const v = await ask(`<h2>Change price</h2><p>${esc(l.d)}: list ${money(l.listTotal)} for this line</p>
      <label>Charge for the line (P)<input name="total" inputmode="decimal" value="${Math.abs(l.lineTotal).toFixed(2)}" autofocus></label>
      <label>or discount %<input name="pct" inputmode="decimal"></label>${buttons()}`)
    if (!v) return
    const sign = cart.kind === 'refund' ? -1 : 1
    let t = v.pct ? Math.abs(l.listTotal) * (1 - num(v.pct) / 100) : num(v.total)
    if (!(t >= 0)) { banner('The price must be zero or more.', true); return }
    l.lineTotal = sign * round2(t)
    render()
  }

  function bump(d) {
    const l = cart.lines[sel]
    if (!l) return
    const step = l.n
    const sign = cart.kind === 'refund' ? -1 : 1
    const next = Math.abs(l.units) + d * step
    if (next <= 0) { removeLine(); return }
    const ratio = l.lineTotal / (l.listTotal || 1)
    l.units = sign * next
    const keepPrice = l.lineTotal !== l.listTotal
    l.listTotal = linePrice(l.p, l.n, l.units)
    l.lineTotal = keepPrice ? round2(l.listTotal * ratio) : l.listTotal
    render()
  }

  function removeLine() {
    if (sel < 0) return
    cart.lines.splice(sel, 1)
    sel = Math.min(sel, cart.lines.length - 1)
    render()
  }

  // ------------------------------------------------------------ paying

  async function pay() {
    if (!cart.lines.length) return
    if (!(await ensureRun())) return
    const { total } = totals()
    const refund = cart.kind === 'refund'
    const due = Math.abs(total)
    const payments = []
    let accountId = null
    let medicalAid = null
    let memberNo = null
    let cashTendered = 0
    const order = refund ? ['cash', 'card', 'eft', 'account'] : ['cash', 'card', 'cheque', 'eft', 'account', 'medical_aid']
    for (;;) {
      const paid = round2(payments.reduce((a, p) => a + p.amount, 0))
      const left = round2(due - paid)
      if (left <= 0 && payments.length) break
      if (due === 0) break
      const v = await ask(`<h2>${refund ? 'Refund' : 'Pay'} ${money(due)}</h2>
        ${payments.length ? `<table>${payments.map((p) => `<tr><td>${tenderNames[p.tender]}${p.reference ? ` <span class="muted">${esc(p.reference)}</span>` : ''}</td><td class="n">${money(p.amount)}</td></tr>`).join('')}<tr><td><b>Still to ${refund ? 'refund' : 'pay'}</b></td><td class="n"><b>${money(left)}</b></td></tr></table>` : ''}
        <div class="tenders">${order.map((t, i) => `<button type="button" data-t="${t}"><kbd>${i + 1}</kbd>${tenderNames[t]}</button>`).join('')}</div>
        <input type="hidden" name="tender" value="cash">
        <label>Amount (P)<input name="amount" inputmode="decimal" value="${left.toFixed(2)}" autofocus></label>
        <div data-extra></div>
        <p class="err" data-err></p>${buttons(refund ? 'Refund' : 'Take payment')}`, (f) => {
        const pick = (t) => {
          f.tender.value = t
          f.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === t))
          const extra = f.querySelector('[data-extra]')
          if (t === 'account') extra.innerHTML = `<label>Account<select name="account">${(cat.accounts || []).map((a) => `<option value="${a.id}" ${a.id === accountId ? 'selected' : ''}>${esc(a.name)} (${esc(a.no)})</option>`).join('')}</select></label>`
          else if (t === 'medical_aid') extra.innerHTML = `<label>Medical aid<input name="aid" value="${esc(medicalAid || 'BOMAid')}"></label><label>Member number<input name="member" value="${esc(memberNo || '')}"></label>`
          else if (t === 'card' || t === 'cheque' || t === 'eft') extra.innerHTML = `<label>Reference (optional)<input name="ref"></label>`
          else extra.innerHTML = ''
          f.amount.focus(); f.amount.select()
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
        accountId = v.account
      }
      if (v.tender === 'medical_aid') { medicalAid = (v.aid || '').trim(); memberNo = (v.member || '').trim(); if (!medicalAid) { banner('Enter the medical aid name.', true); continue } }
      if (v.tender === 'cash' && !refund) {
        cashTendered = round2(cashTendered + amount)
        amount = Math.min(amount, left)                 // anything over is change
      } else if (amount > left) { banner(`Only ${money(left)} is left to ${refund ? 'refund' : 'pay'}; only cash can be more, for change.`, true); continue }
      banner('')
      const existing = payments.find((p) => p.tender === v.tender && !v.ref && !p.reference)
      if (existing) existing.amount = round2(existing.amount + amount)
      else payments.push({ tender: v.tender, amount, reference: v.ref || null })
    }
    const sign = refund ? -1 : 1
    const cashPaid = round2(payments.filter((p) => p.tender === 'cash').reduce((a, p) => a + p.amount, 0))
    const change = refund ? 0 : round2(cashTendered - cashPaid)
    const sale = {
      id: uuid(), runId: run.id, kind: cart.kind, refundOf: cart.refundOf, occurredAt: new Date().toISOString(),
      accountId, medicalAid, memberNo, cashTendered: cashPaid > 0 && !refund ? cashTendered : null,
      lines: cart.lines.map((l) => ({ itemId: l.i, qtyUnits: l.units, listTotal: l.listTotal, lineTotal: l.lineTotal })),
      payments: payments.map((p) => ({ ...p, amount: round2(sign * p.amount) })),
    }
    queue({ type: 'sale', data: sale })
    const slipNo = (load('slipNo', 0) || 0) + 1
    save('slipNo', slipNo)
    lastSlip = { sale, slipNo, lines: cart.lines.map((l) => ({ d: l.d, units: l.units, n: l.n, lineTotal: l.lineTotal })), change, cashier: user.name, at: sale.occurredAt }
    save('lastSlip', lastSlip)
    const last = $('last')
    last.hidden = false
    last.innerHTML = refund ? `Refunded <b>${money(due)}</b>` : change > 0 ? `Change <b>${money(change)}</b>` : `Paid <b>${money(due)}</b>`
    cart = newCart()
    sel = -1
    render()
    sync()
  }

  // ------------------------------------------------------------ other drawer entries

  async function pettyCash() {
    if (!(await ensureRun())) return
    const v = await ask(`<h2>Petty cash out of the drawer</h2>
      <label>Amount (P)<input name="amount" inputmode="decimal" autofocus></label>
      <label>What for<input name="note" required maxlength="200"></label>${buttons('Record')}`)
    if (!v) return
    const amount = round2(num(v.amount))
    if (!(amount > 0) || !v.note.trim()) { banner('Petty cash needs an amount and what it was for.', true); return }
    queue({ type: 'till_entry', data: { id: uuid(), runId: run.id, kind: 'petty_cash', tender: 'cash', amount, note: v.note.trim(), occurredAt: new Date().toISOString() } })
    banner(`Petty cash ${money(amount)} recorded.`)
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
    queue({ type: 'till_entry', data: { id: uuid(), runId: run.id, kind: 'account_payment', tender: v.tender, amount, accountId: v.account, occurredAt: new Date().toISOString() } })
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
      <div>${new Date(s.at).toLocaleString('en-GB')} · ${esc(till ? till.code : '')}-${s.slipNo} · ${esc(s.cashier)}</div><hr>
      <table>${s.lines.map((l) => `<tr><td>${esc(l.d)}<br>${l.units % l.n === 0 ? l.units / l.n : l.units + '/' + l.n}</td><td class="n">${money(l.lineTotal)}</td></tr>`).join('')}</table><hr>
      <table><tr><td><b>Total incl VAT</b></td><td class="n"><b>${money(total)}</b></td></tr>
      ${s.sale.payments.map((p) => `<tr><td>${tenderNames[p.tender]}</td><td class="n">${money(p.tender === 'cash' && s.change ? p.amount + s.change : p.amount)}</td></tr>`).join('')}
      ${s.change ? `<tr><td>Change</td><td class="n">${money(s.change)}</td></tr>` : ''}</table>
      ${t && t.receiptFooter ? `<hr><div class="c">${esc(t.receiptFooter)}</div>` : ''}`
    window.print()
  }

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
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
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
        if (r.status === 'rejected') failed.push({ op, error: r.error, at: new Date().toISOString() })
      }
      outbox = outbox.filter((o) => !done.has(o))
      save('outbox', outbox)
      save('failed', failed)
      if (run && body.runs[run.id]) {
        run.runNo = body.runs[run.id].runNo
        if (body.runs[run.id].status === 'closed') {
          banner(`Run ${run.runNo} has been cashed up. The next sale opens a new run.`)
          run = null
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
    try {
      const res = await fetch('/api/till/catalogue', { credentials: 'same-origin' })
      if (res.status === 401) { banner('Your login has expired. <a href="/login">Log in again</a>.', true); return }
      if (!res.ok) throw new Error()
      cat = await res.json()
      user = cat.user
      save('catalogue', cat)
      index()
      setOnline(true)
      if (tillId && !cat.tills.some((t) => t.id === tillId)) { tillId = null; save('till', null) }
      header()
    } catch {
      setOnline(false)
      if (!cat) banner('The till needs to reach the server once to load the item list.', true)
    }
  }

  function setOnline(v) { online = v; header() }

  // ------------------------------------------------------------ keys

  async function toggleRefund() {
    if (cart.lines.length) { banner('Finish or clear this sale before switching between sale and refund.', true); return }
    cart = newCart(cart.kind === 'refund' ? 'sale' : 'refund')
    render()
  }

  document.addEventListener('keydown', async (e) => {
    if (modalDone) { if (e.key === 'Escape') { e.preventDefault(); modalDone(null) } return }
    const scan = $('scan')
    const inScan = e.target === scan
    const k = e.key
    const fkeys = { F4: changeQty, F5: pay, F6: changePrice, F8: toggleRefund, F9: pettyCash, F10: accountPayment, F12: printSlip }
    if (fkeys[k]) { e.preventDefault(); fkeys[k](); return }
    if (k === 'Escape') {
      e.preventDefault()
      if (results.length) { results = []; showResults(); scan.value = ''; return }
      if (cart.lines.length) {
        const v = await ask(`<h2>Clear this sale?</h2><p>${cart.lines.length} line(s), ${money(totals().total)}</p>${buttons('Clear sale')}`)
        if (v) { cart = newCart(cart.kind); sel = -1; render() }
      }
      return
    }
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
