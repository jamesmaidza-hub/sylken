import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { raw } from 'hono/html'
import type { Ctx, Env } from './app.js'
import { frameCss, Icon, menus, MenuBar, modulePath, modulesFor, type IconName } from './layout.js'

/**
 * The till screen. It is a small browser app, not a server-rendered page: it keeps the item
 * list, the current run and every sale it rings up in the browser, so it keeps selling when
 * the internet drops, and sends what it recorded to /api/till/sync when it can.
 */
const asset = (name: string) => readFileSync(new URL(`./till/${name}`, import.meta.url), 'utf8')
const appJs = asset('app.js')
const swJs = asset('sw.js')
const css = asset('till.css')

export function tillRoutes() {
  const r = new Hono<Env>()

  r.get('/till', (c) => c.redirect('/till/'))
  r.get('/till/', tillPage)

  r.get('/till/app.js', (c) => {
    c.header('content-type', 'text/javascript; charset=utf-8')
    c.header('cache-control', 'no-cache')
    return c.body(appJs)
  })

  // Served from /till/ so it may control the till page; it keeps the page usable offline.
  r.get('/till/sw.js', (c) => {
    c.header('content-type', 'text/javascript; charset=utf-8')
    c.header('cache-control', 'no-cache')
    return c.body(swJs)
  })

  return r
}

function tillPage(c: Ctx) {
  const u = c.get('user')
  const mods = modulesFor(u)
  const mod = mods.find((m) => m.slug === 'till')
  const boot = JSON.stringify({ tenantId: u.tenantId, tenantName: u.tenantName, user: { id: u.userId, name: u.name, roles: u.roles } })
  return c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Till · sylken</title>
        <style>{raw(css)}</style>
        <style>{raw(frameCss + tillFrameCss)}</style>
      </head>
      <body class="framed" style={`--mod:${mod?.color ?? '#0f7a5f'}`}>
        <div id="app">
          <div class="frame">
            <div class="titlebar">
              <a class="brand" href={modulePath('till')} title="The Till module">sylken Till · Invoicing</a>
              <span class="shop">{u.tenantName}</span>
              <span id="till-label">Till</span>
              <span id="run-label"></span>
              <label class="cashier-code" title="Type your 2-letter staff code before each sale"><span>Cashier code</span>
                <input id="cashier-code" maxlength={2} autocomplete="off" autocapitalize="characters" spellcheck={false} placeholder="XX" /></label>
              <span id="cashier"></span>
              <span class="spacer"></span>
              <span id="net" class="net">…</span>
              <span id="pending"></span>
              <button id="cash-alert" type="button" class="cash-alert" hidden title="The drawer holds more cash than the shop's limit. Press F7 to record a cash drop.">⚠ Cash drop due</button>
              <button id="touch-toggle" type="button" class="tb-btn" title="Switch between the keyboard layout and big buttons for a touch screen">Touch screen</button>
              <a class="tb-btn" href="/logout">Log out</a>
            </div>
            {mod && <MenuBar mod={mod} />}
            <div class="toolstrip">
              <nav class="tools" aria-label="Till keys">{tillTools.map(([icon, label, key], n) => (
                <button type="button" class={`tool${n === 0 ? ' main' : ''}`} data-key={key}><Icon name={icon} /><span>{label}</span><kbd>{key}</kbd></button>
              ))}</nav>
              <nav class="switch" aria-label="Other modules">{mods.filter((m) => m.slug !== 'till').map((m) => (
                <a href={modulePath(m.slug)} style={`--c:${m.color}`}><i />{m.name}</a>
              ))}<a href={modulePath('till')} style={`--c:${mod?.color ?? '#0f7a5f'}`}><i />Till module</a></nav>
            </div>
          </div>
          <div id="banner" class="banner" hidden></div>
          <main>
            <section class="left">
              <div class="scan">
                <span id="mode" class="mode" hidden>REFUND</span>
                <input id="scan" autocomplete="off" spellcheck={false} placeholder="Scan a barcode, or type a name or code   (3*code sells 3)" autofocus />
                <ul id="results" class="results" hidden></ul>
              </div>
              <table class="cart">
                <thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Price</th><th class="n">Total</th></tr></thead>
                <tbody id="lines"></tbody>
              </table>
              <div id="empty" class="empty">
                <p><b>Scan an item to start a sale.</b></p>
                <p class="muted">Or type part of its name and pick it with ↑ ↓ and Enter. Type <kbd>3*</kbd> before a code to sell three. Press <kbd>Enter</kbd> on an empty box to pay.</p>
              </div>
            </section>
            <aside class="right">
              <div class="due"><span id="due-label">To pay</span><b id="total">P0.00</b><span id="count" class="muted"></span></div>
              <div id="last" class="last" hidden></div>
              <div id="touch" class="touch">
                <div id="quick" class="quick-items"></div>
                <div class="pad">
                  <button type="button" data-k="7">7</button><button type="button" data-k="8">8</button><button type="button" data-k="9">9</button>
                  <button type="button" class="act" data-a="qty">Quantity</button>
                  <button type="button" data-k="4">4</button><button type="button" data-k="5">5</button><button type="button" data-k="6">6</button>
                  <button type="button" class="act" data-a="price">Change price</button>
                  <button type="button" data-k="1">1</button><button type="button" data-k="2">2</button><button type="button" data-k="3">3</button>
                  <button type="button" class="act warn" data-a="void">Void line</button>
                  <button type="button" data-k="C">C</button><button type="button" data-k="0">0</button><button type="button" data-k="enter">Enter</button>
                  <button type="button" class="act bad" data-a="voidall">Void all</button>
                  <button type="button" class="act" data-a="script">Script</button><button type="button" class="act" data-a="refund">Refund</button>
                  <button type="button" class="act" data-a="reprint">Reprint</button>
                  <button type="button" class="pay" data-a="pay">Pay</button>
                  <button type="button" class="act" data-a="nosale">No sale</button><button type="button" class="act" data-a="drop">Cash drop</button>
                </div>
              </div>
              <dl class="keys">
                <dt>F5</dt><dd>Pay</dd>
                <dt>F2</dt><dd>Script by number</dd>
                <dt>F3</dt><dd>No sale (open the drawer, with a reason)</dd>
                <dt>F7</dt><dd>Cash drop to the safe</dd>
                <dt>F4</dt><dd>Quantity</dd>
                <dt>F6</dt><dd>Change price</dd>
                <dt>Del</dt><dd>Remove line</dd>
                <dt>+ −</dt><dd>One more / less</dd>
                <dt>F8</dt><dd>Refund mode</dd>
                <dt>F9</dt><dd>Petty cash</dd>
                <dt>F10</dt><dd>Account payment</dd>
                <dt>F12</dt><dd>Reprint last slip</dd>
                <dt>Esc</dt><dd>Clear sale</dd>
              </dl>
              <div id="failed" class="failed" hidden></div>
            </aside>
          </main>
        </div>
        <div id="modal" class="modal" hidden><form id="modal-form" class="box"></form></div>
        <div id="slip" class="slip"></div>
        <script>{raw(`window.SYLKEN=${boot.replace(/</g, '\\u003c')}`)}</script>
        <script src="/till/app.js"></script>
        <script>{raw(menus + toolKeys)}</script>
      </body>
    </html>,
  )
}

/** The till's own toolbar: each button does what its F-key does. */
const tillTools: [IconName, string, string][] = [
  ['cash', 'Pay', 'F5'], ['rx', 'Script', 'F2'], ['plus', 'Quantity', 'F4'], ['tag', 'Price', 'F6'], ['undo', 'Refund', 'F8'],
  ['drawer', 'Petty cash', 'F9'], ['acct', 'Account', 'F10'], ['print', 'Reprint', 'F12'], ['lock', 'No sale', 'F3'], ['box', 'Cash drop', 'F7'],
]

const toolKeys = `
document.querySelectorAll('.tools [data-key]').forEach(b=>b.addEventListener('click',()=>{
  document.dispatchEvent(new KeyboardEvent('keydown',{key:b.dataset.key,bubbles:true,cancelable:true}))}))`

// The till keeps its own layout under the frame; the key list moves into the toolbar.
const tillFrameCss = `
#app>.frame .titlebar{flex-wrap:nowrap;white-space:nowrap}
#app>.frame .cashier-code{display:flex;align-items:center;gap:6px;font-weight:600}
#app>.frame .cashier-code input{width:56px;padding:2px 6px;text-align:center;text-transform:uppercase;letter-spacing:2px;font-weight:700;border:1px solid #fff;border-radius:3px;color:#111;background:#fff}
#app>.frame .net{background:rgba(255,255,255,.18);color:#fff}#app>.frame .net.off{background:#b42318}
#app>.frame #run-label,#app>.frame #cashier,#app>.frame #pending{opacity:.85}
button.tool{background:none;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
body:not(.touch-mode) dl.keys{display:none}
`
