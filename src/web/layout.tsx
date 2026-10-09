import type { Child } from 'hono/jsx'
import { raw } from 'hono/html'
import type { SessionUser } from '../domain/auth.js'
import { formatPacks } from '../domain/units.js'

export const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '' : `${n < 0 ? '-' : ''}P${Math.abs(n).toLocaleString('en-BW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '' : `${n.toFixed(1)}%`)

export const qty = (units: number, packSize: number) => formatPacks(units, packSize)

export const date = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''

export const dateTime = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

const nav: [string, string, string][] = [
  ['F2', 'Stock', '/items'],
  ['F3', 'Receive', '/receiving'],
  ['F4', 'Stock take', '/stocktakes'],
  ['F5', 'Dispensary', '/dispensary'],
  ['F6', 'Order', '/reports/minmax'],
  ['F7', 'Reports', '/reports'],
  ['F8', 'Settings', '/settings'],
  ['F9', 'Till', '/till/'],
  ['F10', 'Cash-up', '/cashup'],
  ['', 'Sales', '/sales'],
  ['', 'Accounts', '/accounts'],
]

const css = `
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1d2330;--muted:#5d6676;--line:#dde1e7;--accent:#0d6b5e;--accent-ink:#fff;--warn:#a5530a;--bad:#b42318;--good:#18794e;--chip:#eef1f4}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--panel:#1c2027;--ink:#e6e9ee;--muted:#9aa3b2;--line:#2e343e;--accent:#3fb6a2;--accent-ink:#0b1512;--warn:#e7a35b;--bad:#f07167;--good:#5fd39a;--chip:#262b34}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;gap:12px;align-items:center;padding:6px 16px;position:sticky;top:0;z-index:20;background:var(--panel);border-bottom:1px solid var(--line);flex-wrap:wrap}
header .brand{font-weight:700;color:var(--accent);text-decoration:none;font-size:16px}
header nav{display:flex;gap:2px;flex-wrap:wrap}header nav a{color:var(--ink);text-decoration:none;padding:5px 8px;border-radius:6px;white-space:nowrap}
header nav a:hover{background:var(--chip)}header nav a.on{background:var(--accent);color:var(--accent-ink)}header nav a.on kbd{background:transparent;color:inherit;border-color:currentColor;opacity:.8}kbd{font:11px ui-monospace,monospace;background:var(--chip);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-right:4px;color:var(--muted)}
header .who{margin-left:auto;color:var(--muted);font-size:13px;white-space:nowrap}header #touch-toggle{margin-left:auto}header #touch-toggle+.who{margin-left:4px}
main{padding:16px;max-width:1200px;margin:0 auto}h1{font-size:20px;margin:4px 0 12px}h2{font-size:16px;margin:20px 0 8px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;background:var(--panel)}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.02em}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr.sel{outline:2px solid var(--accent);outline-offset:-2px;background:color-mix(in srgb,var(--accent) 10%,transparent)}tbody tr:hover{background:var(--chip)}tr[data-href]{cursor:pointer}tr.dim td{color:var(--muted)}tr.dim td a{color:var(--muted)}
.wrap{overflow-x:auto}a{color:var(--accent)}
input,select,textarea,button{font:inherit;color:inherit}input,select,textarea{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 8px;min-width:0}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);border-color:transparent}
button:focus-visible,.btn:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
button:hover,.btn:hover{filter:brightness(1.08)}
button,.btn{background:var(--accent);color:var(--accent-ink);border:0;border-radius:6px;padding:7px 14px;cursor:pointer;text-decoration:none;display:inline-block}
button.secondary,.btn.secondary{background:var(--chip);color:var(--ink)}button.danger{background:var(--bad);color:#fff}
form.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px 16px;align-items:end}
form.grid label,label.f{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.spacer{flex:1}
.chip{display:inline-block;background:var(--chip);border-radius:10px;padding:0 8px;font-size:12px;margin:1px 2px 1px 0}
.st-active{color:var(--good)}.st-dormant{color:var(--muted)}.st-quarantined{color:var(--bad)}.st-discontinued{color:var(--muted)}
.msg{padding:8px 12px;border-radius:6px;margin-bottom:12px}.msg.err{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}.msg.ok{background:color-mix(in srgb,var(--good) 15%,transparent);color:var(--good)}.msg.warn{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px}
.stat b{display:block;font-size:22px}a.stat{text-decoration:none;color:inherit}a.stat:hover{border-color:var(--accent)}.stat span{color:var(--muted);font-size:12px}
.muted{color:var(--muted)}.keybar{display:flex;gap:4px 14px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin:6px 0 0}
@keyframes flash{from{background:color-mix(in srgb,var(--accent) 30%,transparent)}to{background:transparent}}.flash{animation:flash .8s ease-out}.neg{color:var(--bad)}.pos{color:var(--good)}.hint{color:var(--muted);font-size:12px}
.blocks{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:12px}
.block{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 16px}.block h3{font-size:15px;margin:0 0 6px}
table.sumtab{background:none;margin-top:6px}table.sumtab td{border:0;padding:2px 0}table.sumtab tr.t td{border-top:1px solid var(--line)}
tfoot td{font-variant-numeric:tabular-nums}
/* Script screen: one form on the left, patient, dates and money on the right, keys along the bottom. */
.rx-desk{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:12px;align-items:start}
.rx-form{font-size:16px;padding:16px 20px}
.rx-row{display:flex;gap:8px 12px;align-items:center;flex-wrap:wrap;margin:0 0 12px}
.rx-row>label:not(.rx-l):not(.chk){color:var(--muted)}
.rx-l{width:112px;flex:none;font-weight:600;color:var(--muted)}
.rx-form input,.rx-form select{font-size:17px;padding:8px 10px}.rx-form .grow{flex:1;min-width:220px}.rx-form .num{width:84px}
.rx-form button,.rx-form .btn{padding:9px 18px;font-size:16px}
.rx-big{font-size:20px}.chk{display:flex;align-items:center;gap:6px}
.rx-info{margin:-4px 0 12px 124px;min-height:1.45em;font-size:15px}
.rx-instr{flex:1;min-height:46px;padding:10px 12px;border:1px dashed var(--line);border-radius:6px;font-size:17px;background:var(--bg)}
.rx-side{padding:14px 16px}.rx-side h3{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.rx-kv{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;margin:0;font-size:15px}.rx-kv dt{color:var(--muted)}.rx-kv dd{margin:0}.rx-kv dd.n{text-align:right;font-variant-numeric:tabular-nums}
.rx-total{font-size:22px;font-weight:700}.rx-allergy{margin:10px 0 0;font-size:16px}
.fbar{position:fixed;left:0;right:0;bottom:0;z-index:15;display:flex;gap:4px 20px;flex-wrap:wrap;padding:8px 16px;background:var(--panel);border-top:1px solid var(--line);font-size:14px}
.fbar kbd{font-size:12px}body:has(.fbar) main{padding-bottom:64px}
.finder{width:min(980px,96vw);max-height:92vh;border:1px solid var(--line);border-radius:10px;padding:16px 20px;background:var(--panel);color:var(--ink);box-shadow:0 20px 60px rgba(0,0,0,.35)}
.finder::backdrop{background:rgba(15,20,30,.45)}.finder>input{width:100%;font-size:18px;padding:10px 12px;margin:10px 0}
.fd-grid{max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:6px}.fd-grid table{font-size:15px}.fd-grid thead th{position:sticky;top:0;background:var(--panel)}.fd-grid tbody tr{cursor:pointer}
.fd-tabs{display:flex;gap:4px;margin:14px 0 0;border-bottom:1px solid var(--line)}.fd-tabs button{background:none;color:var(--muted);border-radius:6px 6px 0 0;padding:8px 16px}
.fd-tabs button.on{color:var(--ink);background:var(--bg);box-shadow:inset 0 -3px 0 var(--accent);font-weight:600}
.fd-detail{min-height:130px;padding:12px 4px 0}
@media (max-width:980px){.rx-desk{grid-template-columns:1fr}}
@media (max-width:640px){.rx-l{width:100%}.rx-info{margin-left:0}}
/* Touch screen layout: bigger rows, fields and buttons; screens may add big-button panels (.touch-only). */
.toolbar{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
.toolbar a{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:92px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);text-decoration:none;font-size:13px}
.toolbar a:hover{border-color:var(--accent)}.toolbar a.on{border-color:var(--accent);box-shadow:inset 0 -3px 0 var(--accent)}
.toolbar .ico{font-size:24px;line-height:1.1}
body.touch-mode .toolbar a{min-width:110px;padding:12px;font-size:15px}body.touch-mode .toolbar .ico{font-size:30px}
.touch-only{display:none}
body.touch-mode{font-size:17px}
body.touch-mode .touch-only{display:block}
body.touch-mode input,body.touch-mode select{min-height:46px;font-size:17px}
body.touch-mode button,body.touch-mode .btn{min-height:46px;padding:10px 18px}
body.touch-mode th,body.touch-mode td{padding:12px 10px}
body.touch-mode header{font-size:15px}body.touch-mode header nav a{padding:9px 8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin:8px 0}
.tile{min-height:60px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-weight:600;text-align:center;line-height:1.2;color:#fff;border-radius:8px;padding:6px}
.tile small{font-weight:400;font-size:12px;opacity:.9}
.tile.plain{background:var(--panel);color:var(--ink);border:1px solid var(--line)}
.tile.on{outline:3px solid var(--accent);outline-offset:2px}
.c-green{background:#18794e}.c-blue{background:#1d5fbf}.c-teal{background:#0d6b5e}.c-amber{background:#a5530a}.c-red{background:#b42318}.c-purple{background:#6941c6}.c-grey{background:#5d6676}
.numpad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.numpad button{min-height:58px;font-size:22px;font-weight:600;background:var(--panel);color:var(--ink);border:1px solid var(--line)}
.bigacts{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.bigacts button,.bigacts a.btn{min-height:60px;font-size:17px;font-weight:600;text-align:center;display:flex;align-items:center;justify-content:center}
.touchgrid{display:grid;grid-template-columns:1.6fr 1fr;gap:16px;align-items:start}
@media (max-width:900px){.touchgrid{grid-template-columns:1fr}}
@media (max-width:640px){main{padding:12px 16px}header{gap:8px}header .who{margin-left:0}}
`

// Touch screen layout, remembered per browser. Screens add .touch-only panels for it.
const touch = `
(() => {
  const k = 'sylken:touch', b = document.getElementById('touch-toggle')
  let on = false; try { on = localStorage.getItem(k) === '1' } catch {}
  const set = (v) => { on = v; document.body.classList.toggle('touch-mode', v); if (b) b.textContent = v ? 'Keyboard layout' : 'Touch screen'; try { localStorage.setItem(k, v ? '1' : '0') } catch {} }
  set(on)
  if (b) b.onclick = () => set(!on)
})()`

// Function keys work everywhere, like Compharm. "/" jumps to the search box, arrows move through result rows.
// A screen can claim keys of its own in window.pageKeys (e.g. the script screen's F3/F4/F8/F9 and Ctrl+U).
const keys = `
document.addEventListener('keydown',e=>{
  const own=window.pageKeys&&window.pageKeys[(e.ctrlKey?'Ctrl+':'')+(e.key.length===1?e.key.toLowerCase():e.key)];
  if(own){e.preventDefault();own(e);return}
  const map={F2:'/items',F3:'/receiving',F4:'/stocktakes',F5:'/dispensary',F6:'/reports/minmax',F7:'/reports',F8:'/settings',F9:'/till/',F10:'/cashup'};
  if(map[e.key]){e.preventDefault();location.href=map[e.key];return}
  const t=e.target, typing=t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT');
  if(e.key==='/'&&!typing){const s=document.querySelector('[data-search]');if(s){e.preventDefault();s.focus();s.select()}return}
  const rows=[...document.querySelectorAll('tr[data-href]')];if(!rows.length)return;
  let i=rows.findIndex(r=>r.classList.contains('sel'));
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){if(typing&&!t.hasAttribute('data-search'))return;e.preventDefault();
    if(i>=0)rows[i].classList.remove('sel');i=e.key==='ArrowDown'?Math.min(i+1,rows.length-1):Math.max(i-1,0);
    rows[i].classList.add('sel');rows[i].scrollIntoView({block:'nearest'})}
  if(e.key==='Enter'&&i>=0&&(!typing||t.hasAttribute('data-search'))&&!(t&&t.closest&&t.closest('button,a'))){e.preventDefault();location.href=rows[i].dataset.href}
});
document.addEventListener('click',e=>{const r=e.target.closest('tr[data-href]');if(r&&!e.target.closest('a,button,input'))location.href=r.dataset.href});
`

/** The nav entry with the longest href that prefixes the path, so /reports/minmax lights up Order, not Reports. */
function current(path = '') {
  return nav.map(([, , href]) => href).filter((h) => path.startsWith(h)).sort((a, b) => b.length - a.length)[0]
}

export function Layout(props: { title: string; user?: SessionUser | null; path?: string; children?: Child; flash?: { ok?: string; err?: string } }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · sylken</title>
        <style>{raw(css)}</style>
      </head>
      <body>
        {props.user && (
          <header>
            <a class="brand" href="/">sylken</a>
            <nav>
              {nav.map(([k, label, href]) => (
                <a href={href} class={href === current(props.path) ? 'on' : ''}>{k && <kbd>{k}</kbd>}{label}</a>
              ))}
            </nav>
            <button type="button" id="touch-toggle" class="secondary" style="padding:4px 10px;font-size:13px" title="Bigger buttons for a touch screen">Touch screen</button>
            <span class="who" title={`${props.user.tenantName} · ${props.user.role}`}>{props.user.name} · <a href="/logout">Log out</a></span>
          </header>
        )}
        <main>
          {props.flash?.err && <div class="msg err">{props.flash.err}</div>}
          {props.flash?.ok && <div class="msg ok">{props.flash.ok}</div>}
          {props.children}
        </main>
        <script>{raw(keys)}</script>
        <script>{raw(touch)}</script>
      </body>
    </html>
  )
}

export function StatusChip({ status, reason }: { status: string; reason?: string | null }) {
  return <span class={`st-${status}`} title={reason ?? ''}>{status}</span>
}
