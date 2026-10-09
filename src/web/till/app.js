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
  // Cash due is rounded to the shop's smallest coin (5 thebe in Botswana), same rule as the server.
  const roundCash = (n) => { const s = (cat && cat.tenant.cashRounding) || 0.01; return s > 0.01 ? round2(Math.round(n / s + 1e-9) * s) : round2(n) }
  const vatIn = (n, rate) => round2((n * rate) / (1 + rate))
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

  function newCart(kind = 'sale') { return { kind, lines: [], refundOf: null, script: null } }

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
      return `<tr class="${i === sel ? 'sel' : ''}" data-i="${i}"><td>${l.sl ? `<span class="rx">Rx ${esc(cart.script.scriptNo)}</span> ` : ''}${esc(l.d)} <span class="code">${esc(l.c)}</span></td>
        <td class="n">${qty}</td><td class="n">${money(l.p)}</td>
        <td class="n">${changed ? `<span class="was">${money(l.listTotal)}</span>` : ''}${money(l.lineTotal)}</td></tr>`
    }).join('')
    $('empty').hidden = cart.lines.length > 0
    if (cart.lines.length) $('last').hidden = true
    const { total } = totals()
    $('total').textContent = money(total)
    const count = cart.lines.length
    $('count').textContent = count ? `${count} line${count === 1 ? '' : 's'}` : ''
    $('due-label').textContent = cart.kind === 'refund' ? 'To refund' : 'To pay'
    document.querySelector('.due').classList.toggle('refund', cart.kind === 'refund')
    $('mode').hidden = cart.kind !== 'refund'
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
    const existing = units === null && cart.lines.findIndex((l) => !l.sl && l.i === it.i && l.lineTotal === l.listTotal && l.units % n === 0)
    if (existing !== false && existing >= 0) {
      const l = cart.lines[existing]
      l.units += u
      if (l.units === 0) { cart.lines.splice(existing, 1); sel = Math.min(sel, cart.lines.length - 1) } else { reprice(l); sel = existing }
    } else {
      const l = { i: it.i, c: it.c, d: it.d, p: it.p, n, v: it.v ?? cat.tenant.vatRate ?? 0.14, units: u, listTotal: 0, lineTotal: 0 }
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
    l.units = sign * units
    reprice(l)
    render()
  }

  async function changePrice() {
    const l = cart.lines[sel]
    if (!l || scriptLine(l)) return
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
    if (!l || scriptLine(l)) return
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
    if (cart.lines[sel] && cart.lines[sel].sl) {
      cart.lines = cart.lines.filter((l) => !l.sl)
      cart.script = null
      sel = cart.lines.length - 1
      render()
      return
    }
    cart.lines.splice(sel, 1)
    sel = Math.min(sel, cart.lines.length - 1)
    render()
  }

  // ------------------------------------------------------------ scripts

  /** Bring a dispensed script onto the sale by its number. The stock left at dispensing, so these lines take none. */
  async function addScript() {
    if (cart.script) { banner('One script per sale. Finish this sale first.', true); return }
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
    const { total } = totals()
    const refund = cart.kind === 'refund'
    const due = Math.abs(total)
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
          else if (a > owed && f.tender.value === 'cash' && !refund) out.innerHTML = `Change <b>${money(round2(a - owed))}</b>`
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
          else if (t === 'card' || t === 'cheque' || t === 'eft') extra.innerHTML = `<label>Reference (optional)<input name="ref"></label>`
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
      const cashLeft = roundCash(left)
      if (v.tender === 'cash' && amount >= cashLeft && (!refund || amount === cashLeft)) {
        // This cash settles the sale: what's due is rounded to the coin, anything over is change.
        if (!refund) cashTendered = round2(cashTendered + amount)
        rounding = round2(rounding + cashLeft - left)
        amount = cashLeft
      } else if (v.tender === 'cash' && !refund) {
        cashTendered = round2(cashTendered + amount)
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
      accountId, medicalAid, memberNo, cashTendered: cashPaid > 0 && !refund ? cashTendered : null, rounding: round2(sign * rounding),
      scriptId: cart.script ? cart.script.id : null,
      lines: cart.lines.map((l) => ({ itemId: l.i, qtyUnits: l.units, listTotal: l.listTotal, lineTotal: l.lineTotal, scriptLineId: l.sl || null })),
      payments: payments.map((p) => ({ ...p, amount: round2(sign * p.amount) })),
    }
    queue({ type: 'sale', data: sale })
    const slipNo = (load('slipNo', 0) || 0) + 1
    save('slipNo', slipNo)
    const onAccount = round2(payments.filter((p) => p.tender === 'account').reduce((a, p) => a + p.amount, 0))
    if (accountId && onAccount) noteAccountMove(sale.id, accountId, sign * onAccount)
    lastSlip = { sale, slipNo, lines: cart.lines.map((l) => ({ d: l.d, units: l.units, n: l.n, lineTotal: l.lineTotal, v: l.v, vat: l.vat })), change, cashier: user.name, at: sale.occurredAt,
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
    $('scan').value = ''
    results = []
    showResults()
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
    const entryId = uuid()
    queue({ type: 'till_entry', data: { id: entryId, runId: run.id, kind: 'account_payment', tender: v.tender, amount, accountId: v.account, occurredAt: new Date().toISOString() } })
    noteAccountMove(entryId, v.account, -amount)
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
        const move = accountMoves.find((m) => m.id === r.id)
        if (move && !move.syncedAt) move.syncedAt = Date.now()
        if (r.status === 'rejected') failed.push({ op, error: r.error, at: new Date().toISOString() })
      }
      outbox = outbox.filter((o) => !done.has(o))
      save('outbox', outbox)
      save('failed', failed)
      save('accountMoves', accountMoves)
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
    const started = Date.now()
    try {
      const res = await fetch('/api/till/catalogue', { credentials: 'same-origin' })
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
    if (!cart.lines.length) return
    const v = await ask(`<h2>Clear this sale?</h2><p>${cart.lines.length} line(s), ${money(totals().total)}</p>${buttons('Clear sale')}`)
    if (v) { cart = newCart(cart.kind); sel = -1; render() }
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

  function setQtyFromPad() {
    const n = padNumber()
    const l = cart.lines[sel]
    if (n === null || !l) { changeQty(); return }
    if (scriptLine(l)) return
    const units = Math.round(n * l.n)
    const it = cat.items.find((x) => x.i === l.i) || { l: false }
    if (!it.l && units % l.n !== 0) { banner(`${esc(l.d)} is only sold in whole packs.`, true); return }
    l.units = (cart.kind === 'refund' ? -1 : 1) * units
    reprice(l)
    $('scan').value = ''
    render()
  }

  $('touch-toggle').addEventListener('click', () => setTouch(!touch))
  $('quick').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) quickSale(Number(b.dataset.q)) })
  document.querySelector('.pad').addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b || modalDone) return
    const scan = $('scan')
    const k = b.dataset.k
    if (k === 'C') { scan.value = ''; results = []; showResults() }
    else if (k === 'enter') onScanEnter()
    else if (k) scan.value += k
    const actions = { qty: setQtyFromPad, price: changePrice, void: removeLine, voidall: clearSale, script: addScript, refund: toggleRefund, reprint: printSlip, pay }
    if (b.dataset.a) actions[b.dataset.a]()
  })

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
    const fkeys = { F2: addScript, F4: changeQty, F5: pay, F6: changePrice, F8: toggleRefund, F9: pettyCash, F10: accountPayment, F12: printSlip }
    if (fkeys[k]) { e.preventDefault(); fkeys[k](); return }
    if (k === 'Escape') {
      e.preventDefault()
      if (results.length) { results = []; showResults(); scan.value = ''; return }
      clearSale()
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
  setTouch(touch)
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
