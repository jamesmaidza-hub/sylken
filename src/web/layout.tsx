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
  ['F2', 'Items', '/items'],
  ['F3', 'Receive', '/receiving'],
  ['F4', 'Stock take', '/stocktakes'],
  ['F5', 'Dispensary', '/dispensary'],
  ['F6', 'Order (min/max)', '/reports/minmax'],
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
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;gap:16px;align-items:center;padding:8px 16px;background:var(--panel);border-bottom:1px solid var(--line);flex-wrap:wrap}
header .brand{font-weight:700;color:var(--accent);text-decoration:none;font-size:16px}
header nav{display:flex;gap:4px;flex-wrap:wrap}header nav a{color:var(--ink);text-decoration:none;padding:4px 8px;border-radius:6px}
header nav a:hover,header nav a.on{background:var(--chip)}kbd{font:11px ui-monospace,monospace;background:var(--chip);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-right:4px;color:var(--muted)}
header .who{margin-left:auto;color:var(--muted);font-size:13px}
main{padding:16px;max-width:1200px;margin:0 auto}h1{font-size:20px;margin:4px 0 12px}h2{font-size:16px;margin:20px 0 8px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;background:var(--panel)}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.02em}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr.sel{outline:2px solid var(--accent);outline-offset:-2px}tbody tr:hover{background:var(--chip)}
.wrap{overflow-x:auto}a{color:var(--accent)}
input,select,textarea,button{font:inherit;color:inherit}input,select,textarea{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 8px;min-width:0}
input:focus,select:focus{outline:2px solid var(--accent);border-color:transparent}
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
.muted{color:var(--muted)}.neg{color:var(--bad)}.pos{color:var(--good)}.hint{color:var(--muted);font-size:12px}
.blocks{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:12px}
.block{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 16px}.block h3{font-size:15px;margin:0 0 6px}
table.sumtab{background:none;margin-top:6px}table.sumtab td{border:0;padding:2px 0}table.sumtab tr.t td{border-top:1px solid var(--line)}
tfoot td{font-variant-numeric:tabular-nums}
@media (max-width:640px){main{padding:12px 16px}header{gap:8px}header .who{margin-left:0}}
`

// Function keys work everywhere, like Compharm. "/" jumps to the search box, arrows move through result rows.
const keys = `
document.addEventListener('keydown',e=>{
  const map={F2:'/items',F3:'/receiving',F4:'/stocktakes',F5:'/dispensary',F6:'/reports/minmax',F7:'/reports',F8:'/settings',F9:'/till/',F10:'/cashup'};
  if(map[e.key]){e.preventDefault();location.href=map[e.key];return}
  const t=e.target, typing=t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT');
  if(e.key==='/'&&!typing){const s=document.querySelector('[data-search]');if(s){e.preventDefault();s.focus();s.select()}return}
  const rows=[...document.querySelectorAll('tr[data-href]')];if(!rows.length)return;
  let i=rows.findIndex(r=>r.classList.contains('sel'));
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){if(typing&&!t.hasAttribute('data-search'))return;e.preventDefault();
    if(i>=0)rows[i].classList.remove('sel');i=e.key==='ArrowDown'?Math.min(i+1,rows.length-1):Math.max(i-1,0);
    rows[i].classList.add('sel');rows[i].scrollIntoView({block:'nearest'})}
  if(e.key==='Enter'&&i>=0&&(!typing||t.hasAttribute('data-search'))){e.preventDefault();location.href=rows[i].dataset.href}
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
            <span class="who">{props.user.tenantName} · {props.user.name} ({props.user.role}) · <a href="/logout">Log out</a></span>
          </header>
        )}
        <main>
          {props.flash?.err && <div class="msg err">{props.flash.err}</div>}
          {props.flash?.ok && <div class="msg ok">{props.flash.ok}</div>}
          {props.children}
        </main>
        <script>{raw(keys)}</script>
      </body>
    </html>
  )
}

export function StatusChip({ status, reason }: { status: string; reason?: string | null }) {
  return <span class={`st-${status}`} title={reason ?? ''}>{status}</span>
}
