import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { raw } from 'hono/html'
import type { Ctx, Env } from './app.js'

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
  const boot = JSON.stringify({ tenantId: u.tenantId, tenantName: u.tenantName, user: { id: u.userId, name: u.name, role: u.role } })
  return c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Till · sylken</title>
        <style>{raw(css)}</style>
      </head>
      <body>
        <div id="app">
          <header>
            <a class="brand" href="/" title="Back office">sylken</a>
            <span id="till-label">Till</span>
            <span id="run-label" class="muted"></span>
            <span id="cashier" class="muted"></span>
            <span class="spacer"></span>
            <span id="net" class="net">…</span>
            <span id="pending" class="muted"></span>
            <button id="touch-toggle" type="button" class="secondary small" title="Switch between the keyboard layout and big buttons for a touch screen">Touch screen</button>
          </header>
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
                </div>
              </div>
              <dl class="keys">
                <dt>F5</dt><dd>Pay</dd>
                <dt>F2</dt><dd>Script by number</dd>
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
      </body>
    </html>,
  )
}
