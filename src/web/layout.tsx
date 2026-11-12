import type { Child } from 'hono/jsx'
import { raw } from 'hono/html'
import type { SessionUser } from '../domain/auth.js'
import { formatPacks } from '../domain/units.js'
import { security } from '../security/config.js'
import { can, roleLabels, type Permission } from '../security/roles.js'

export const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '' : `${n < 0 ? '-' : ''}P${Math.abs(n).toLocaleString('en-BW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '' : `${n.toFixed(1)}%`)

export const qty = (units: number, packSize: number) => formatPacks(units, packSize)

export const date = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''

export const dateTime = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

/** One screen in a module's drop-down menu or toolbar: F-key (or ''), label, address, permission needed. */
type MenuItem = [key: string, label: string, href: string, perm: Permission]
type Menu = { label: string; items: (MenuItem | '-')[] }
type Tool = [icon: IconName, label: string, key: string, href: string, perm: Permission]

/**
 * sylken is split into modules the way Compharm is split into RxWin, POSWin and StockWin. Each module is
 * its own window: a title bar, a menu bar with drop-down lists of every screen, a toolbar of the jobs done
 * most often, and a key line at the bottom. A person only sees the modules, menus and screens their roles
 * allow. The F-keys stay global and go straight to a screen from anywhere.
 */
export interface Module { slug: string; name: string; color: string; perm: Permission; owns: string[]; menus: Menu[]; tools: Tool[]; keys: [string, string][] }

export const modules: Module[] = [
  {
    slug: 'rx', name: 'Dispensary', color: '#2f5fc4', perm: 'rx.view', owns: ['/dispensary', '/reports/rx'],
    menus: [
      { label: 'Dispensing', items: [
        ['F5', 'Find patient / new script', '/dispensary', 'rx.view'],
        ['', 'New patient', '/dispensary/patients/new', 'rx.capture'],
        '-',
        ['', 'Script book', '/dispensary/scripts', 'rx.view'],
        ['', 'Owed items', '/dispensary/owed', 'rx.view'],
        ['', 'Medical aid claims', '/dispensary/claims', 'rx.claims'],
      ] },
      { label: 'Reports', items: [
        ['', 'Claims', '/dispensary/claims', 'rx.claims'],
        ['', 'Script analysis', '/reports/rx/scripts', 'rx.reports'],
        ['', 'Drug usage', '/reports/rx/drug-usage', 'rx.reports'],
        ['', 'Repeat scripts not recently filled', '/reports/rx/repeats', 'rx.view'],
        ['', 'Schedule 1 register', '/dispensary/register', 'rx.view'],
        ['', 'Script book', '/dispensary/scripts', 'rx.view'],
        ['', 'Patients', '/reports/rx/patients', 'rx.view'],
        ['', 'Script price changes', '/reports/rx/price-changes', 'rx.reports'],
        ['', 'Last patient visit', '/reports/rx/last-visit', 'rx.view'],
        ['', 'Reversed scripts', '/reports/rx/reversed', 'rx.view'],
        '-',
        ['', 'All dispensary reports', '/reports/rx', 'rx.reports'],
      ] },
      { label: 'System', items: [
        ['', 'Dispensary settings', '/dispensary/settings', 'rx.settings'],
        ['', 'Your login and second PIN', '/me', 'self.manage'],
      ] },
      { label: 'Maintenance', items: [
        ['', 'Doctors', '/dispensary/doctors', 'rx.view'],
        ['', 'Dispensers', '/dispensary/dispensers', 'users.manage'],
        ['', 'Logins and roles', '/users', 'users.manage'],
      ] },
    ],
    tools: [
      ['rx', 'New script', 'F5', '/dispensary', 'rx.view'],
      ['person', 'New patient', '', '/dispensary/patients/new', 'rx.capture'],
      ['book', 'Script book', '', '/dispensary/scripts', 'rx.view'],
      ['box', 'Owed items', '', '/dispensary/owed', 'rx.view'],
      ['repeat', 'Repeats', '', '/reports/rx/repeats', 'rx.view'],
      ['claim', 'Claims', '', '/dispensary/claims', 'rx.claims'],
      ['lock', 'Register', '', '/dispensary/register', 'rx.view'],
      ['chart', 'Reports', '', '/reports/rx', 'rx.reports'],
    ],
    keys: [['F5', 'Find patient'], ['/', 'Search'], ['↑ ↓', 'Move'], ['Enter', 'Open'], ['Alt', 'Menus']],
  },
  {
    slug: 'till', name: 'Till', color: '#0f7a5f', perm: 'till.use',
    owns: ['/till', '/cashup', '/sales', '/accounts', '/reports/till', '/reports/sales', '/settings', '/users', '/me'],
    menus: [
      { label: 'Transactions', items: [
        ['F9', 'Invoicing (open the till)', '/till/', 'till.use'],
        ['F10', 'Cash-up', '/cashup', 'cashup.own'],
        ['', 'Cash-up problems', '/cashup/problems', 'cashup.manage'],
        '-',
        ['', 'Sales journal', '/sales', 'sales.view'],
        ['', 'Customer accounts', '/accounts', 'accounts.view'],
        ['', 'Age analysis', '/accounts/aging', 'accounts.view'],
      ] },
      { label: 'Reports', items: [
        ['', 'Daily reports', '/reports/sales', 'sales.view'],
        ['', 'Cash-up procedure', '/cashup', 'cashup.own'],
        ['', 'Statements - accounts', '/reports/till/statements', 'sales.view'],
        ['', 'Invoice reprints', '/reports/till/journal', 'sales.view'],
        ['', "Debtors' reports", '/reports/till/debtors', 'sales.view'],
        ['', 'Cash debtor transactions', '/reports/till/account-transactions', 'sales.view'],
        ['', 'Detail register reports', '/reports/till/detail', 'sales.view'],
        ['', 'Assistants reports', '/reports/till/assistants', 'sales.view'],
        ['', 'Journal report', '/reports/till/journal', 'sales.view'],
        ['', 'Petty cash', '/reports/till/petty-cash', 'sales.view'],
        ['', 'Invoice/script price alterations', '/reports/till/price-alterations', 'sales.view'],
        ['', 'Markup report', '/reports/till/markup', 'sales.view'],
        ['', 'OTC sales', '/reports/till/otc', 'sales.view'],
        ['', 'Contacts', '/reports/till/contacts', 'sales.view'],
        ['', 'Sales and GP by item', '/reports/sales-gp', 'sales.view'],
        ['', 'Audit trail', '/reports/till/audit', 'audit.view'],
      ] },
      { label: 'Maintenance', items: [
        ['F8', 'Shop settings and quick buttons', '/settings', 'settings.manage'],
        ['', 'Logins and roles', '/users', 'users.manage'],
      ] },
      { label: 'System', items: [
        ['', 'Your login and second PIN', '/me', 'self.manage'],
      ] },
    ],
    tools: [
      ['cash', 'Invoicing', 'F9', '/till/', 'till.use'],
      ['drawer', 'Cash-up', 'F10', '/cashup', 'cashup.own'],
      ['book', 'Sales journal', '', '/sales', 'sales.view'],
      ['acct', 'Accounts', '', '/accounts', 'accounts.view'],
      ['claim', 'Statements', '', '/reports/till/statements', 'sales.view'],
      ['print', 'Reprints', '', '/reports/till/journal', 'sales.view'],
      ['chart', 'Daily reports', '', '/reports/sales', 'sales.view'],
      ['gear', 'Settings', 'F8', '/settings', 'settings.manage'],
    ],
    keys: [['F9', 'Open the till'], ['F10', 'Cash-up'], ['F8', 'Settings'], ['Alt', 'Menus']],
  },
  {
    slug: 'stock', name: 'Stock', color: '#b5651d', perm: 'items.view', owns: ['/items', '/receiving', '/stocktakes', '/reports'],
    menus: [
      { label: 'Stock', items: [
        ['F2', 'Items', '/items', 'items.view'],
        ['', 'New item', '/items/new', 'items.edit'],
        ['', 'Stock by bin', '/items/bins', 'items.view'],
        ['', 'ABC list', '/items/abc', 'items.view'],
        ['', 'Usage and velocity', '/items/velocity', 'items.view'],
      ] },
      { label: 'Transactions', items: [
        ['F3', 'Receive a delivery', '/receiving', 'stock.receive'],
        ['F4', 'Stock take', '/stocktakes', 'stock.adjust'],
      ] },
      { label: 'Ordering', items: [
        ['F6', 'Order (min/max)', '/reports/minmax', 'stock.reports'],
      ] },
      { label: 'Reports', items: [
        ['F7', 'All stock reports', '/reports', 'stock.reports'],
        '-',
        ['', 'Stock valuation', '/reports/valuation', 'stock.reports'],
        ['', 'Negative stock', '/reports/negative', 'stock.reports'],
        ['', 'Dormant stock', '/reports/dormant', 'stock.reports'],
        ['', 'Stock adjustments', '/reports/adjustments', 'stock.reports'],
        ['', 'Item GP', '/reports/gp', 'stock.reports'],
        ['', 'Quarantined items', '/reports/quarantine', 'stock.reports'],
      ] },
      { label: 'Maintenance', items: [
        ['F8', 'Shop settings', '/settings', 'settings.manage'],
      ] },
    ],
    tools: [
      ['find', 'Items', 'F2', '/items', 'items.view'],
      ['truck', 'Receive', 'F3', '/receiving', 'stock.receive'],
      ['count', 'Stock take', 'F4', '/stocktakes', 'stock.adjust'],
      ['cart', 'Order', 'F6', '/reports/minmax', 'stock.reports'],
      ['bin', 'Bins', '', '/items/bins', 'items.view'],
      ['plus', 'New item', '', '/items/new', 'items.edit'],
      ['chart', 'Reports', 'F7', '/reports', 'stock.reports'],
    ],
    keys: [['F2', 'Items'], ['F3', 'Receive'], ['F4', 'Stock take'], ['F6', 'Order'], ['/', 'Search'], ['Alt', 'Menus']],
  },
]

/** The modules this person may open, each with only the menus, menu lines and tools their roles allow. */
export function modulesFor(user: SessionUser): Module[] {
  const ok = (perm: Permission) => can(user.roles, perm)
  return modules.filter((m) => ok(m.perm)).map((m) => ({
    ...m,
    menus: m.menus
      .map((g) => ({ ...g, items: g.items.filter((i) => i === '-' || ok(i[3])) }))
      .map((g) => ({ ...g, items: g.items.filter((i, n, all) => i !== '-' || (n > 0 && n < all.length - 1 && all[n - 1] !== '-')) }))
      .filter((g) => g.items.some((i) => i !== '-')),
    tools: m.tools.filter((t) => ok(t[4])),
  }))
}

/** The module a person lands on: the dispensary for dispensary staff, otherwise the till. */
export const homeModule = (user: SessionUser) => modulesFor(user)[0]

export const modulePath = (slug: string) => `/m/${slug}`

/** The module a page belongs to: the one owning the longest prefix of the path; the home module otherwise. */
function moduleOf(mods: Module[], path = ''): Module | undefined {
  if (path.startsWith('/m/')) return mods.find((m) => m.slug === path.slice(3).replace(/\/$/, '')) ?? mods[0]
  let best: Module | undefined, len = 0
  for (const m of mods) for (const o of m.owns) if ((path === o || path.startsWith(o.endsWith('/') ? o : `${o}/`) || path === `${o}/`) && o.length > len) { best = m; len = o.length }
  return best ?? mods[0]
}

const icons = {
  rx: '<path d="M9 3h6v4H9zM6 7h12v14H6z"/><path d="M12 11v6M9 14h6"/>',
  find: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  claim: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7M14 3v5h5"/>',
  book: '<path d="M4 4h7a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H4z"/><path d="M20 4h-4a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>',
  drawer: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18M10 16h4"/>',
  acct: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  truck: '<path d="M2 6h12v10H2zM14 9h4l4 4v3h-8z"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  count: '<path d="M9 5h11M9 12h11M9 19h11"/><path d="M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l3 12h11l2-8H6"/>',
  bin: '<path d="M3 4h18v6H3zM3 14h18v6H3z"/><path d="M10 7h4M10 17h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
} as const
export type IconName = keyof typeof icons
export const Icon = ({ name }: { name: IconName }) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true" class="ic">${icons[name]}</svg>`)

/** The menu bar: each heading opens its drop-down list. Alt + the underlined letter opens it from the keyboard. */
export function MenuBar({ mod }: { mod: Module }) {
  return (
    <nav class="menubar" aria-label={`${mod.name} menus`}>
      {mod.menus.map((g) => (
        <div class="menu">
          <button type="button" class="menu-h" data-alt={g.label[0].toLowerCase()} aria-haspopup="true" aria-expanded="false"><u>{g.label[0]}</u>{g.label.slice(1)}</button>
          <div class="menu-list" role="menu">{g.items.map((i) => i === '-'
            ? <hr />
            : <a role="menuitem" href={i[2]}>{i[1]}{i[0] && <kbd>{i[0]}</kbd>}</a>)}</div>
        </div>
      ))}
      <div class="menu">
        <button type="button" class="menu-h" data-alt="x" aria-haspopup="true" aria-expanded="false">E<u>x</u>it</button>
        <div class="menu-list" role="menu"><a role="menuitem" href="/logout">Log out</a></div>
      </div>
    </nav>
  )
}

/** The toolbar: big buttons for the module's most used screens, and buttons to the other modules on the right. */
export function Toolbar({ mod, mods, here }: { mod: Module; mods: Module[]; here?: string }) {
  return (
    <div class="toolstrip">
      <nav class="tools" aria-label={`${mod.name} toolbar`}>{mod.tools.map(([icon, label, key, href], n) => (
        <a href={href} class={`tool${n === 0 ? ' main' : ''}${href === here ? ' on' : ''}`}><Icon name={icon} /><span>{label}</span>{key && <kbd>{key}</kbd>}</a>
      ))}</nav>
      <nav class="switch" aria-label="Other modules">{mods.filter((m) => m !== mod).map((m) => (
        <a href={modulePath(m.slug)} style={`--c:${m.color}`}><i />{m.name}</a>
      ))}</nav>
    </div>
  )
}

/** The toolbar or menu entry with the longest href that prefixes the path, so /reports/minmax lights up Order, not Reports. */
function current(mod: Module | undefined, path = '') {
  if (!mod) return undefined
  return mod.tools.map((t) => t[3]).filter((h) => path === h || path.startsWith(h.endsWith('/') ? h : `${h}/`)).sort((a, b) => b.length - a.length)[0]
}

// An unattended screen logs itself out, so patient details are not left showing.
const idleLock = `(()=>{let t;const reset=()=>{clearTimeout(t);t=setTimeout(()=>{location.href='/logout?idle=1'},${security.idleMinutes * 60_000})};
['mousemove','mousedown','keydown','touchstart','scroll'].forEach(e=>addEventListener(e,reset,{passive:true}));reset()})()`

/** The module window frame, shared with the till page. */
export const frameCss = `
/* The module window: title bar, menu bar, toolbar at the top; key line at the bottom; the screen fills the rest. */
body.framed{--mod:#2f5fc4;min-height:100vh;display:flex;flex-direction:column;font-family:'Segoe UI',Tahoma,system-ui,sans-serif}
header.frame,div.frame{position:sticky;top:0;z-index:20;background:var(--panel);box-shadow:0 1px 0 var(--line)}
.titlebar{display:flex;align-items:center;gap:12px;height:32px;padding:0 12px;background:linear-gradient(180deg,color-mix(in srgb,var(--mod) 80%,#fff) 0%,var(--mod) 55%,color-mix(in srgb,var(--mod) 85%,#000) 100%);color:#fff;font-size:13px;text-shadow:0 1px 0 rgba(0,0,0,.25)}
.titlebar .brand{color:#fff;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:.01em}
.titlebar .shop{opacity:.85}.titlebar .who{color:#fff;opacity:.9;text-decoration:none}.titlebar .who:hover{text-decoration:underline}
.titlebar .tb-btn{background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:3px;padding:3px 10px;font-size:12.5px;text-decoration:none;cursor:pointer}
.titlebar .tb-btn:hover{background:rgba(255,255,255,.28)}
.menubar{display:flex;align-items:center;gap:0;height:26px;padding:0 4px;border-bottom:1px solid #c9ced6;background:#f0f0f0;color:#1a1a1a}
.menu{position:relative}
.menu-h{background:none;color:#1a1a1a;border:1px solid transparent;border-radius:0;padding:2px 10px;font-size:14px;cursor:default}
.menu-h:hover,.menu.open .menu-h{background:#cce4f7;border-color:#99c9ef;color:#1a1a1a;filter:none}
.menu-h u{text-underline-offset:2px}
.menu-list{display:none;position:absolute;left:0;top:100%;min-width:270px;max-height:calc(100vh - 90px);overflow:auto;background:#f2f2f2;border:1px solid #a0a0a0;border-radius:0;box-shadow:3px 3px 6px rgba(0,0,0,.25);padding:2px;z-index:30}
.menu.open .menu-list{display:block}
.menu-list a{display:flex;justify-content:space-between;gap:16px;padding:4px 18px 4px 28px;color:#1a1a1a;text-decoration:none;white-space:nowrap;font-size:14px;border:1px solid transparent}
.menu-list a:hover,.menu-list a:focus{background:#cce4f7;border-color:#99c9ef;outline:0}.menu-list kbd{background:none;border:0;color:#555}
.menu-list hr{border:0;border-top:1px solid #c9c9c9;border-bottom:1px solid #fff;margin:3px 2px 3px 26px}
.toolstrip{display:flex;align-items:stretch;gap:6px;padding:4px 8px;background:linear-gradient(180deg,#fbfbfb,#e7e9ec);border-bottom:1px solid #b9bfc7;color:#1a1a1a}
.tools{display:flex;gap:4px;flex-wrap:wrap}
.tool{width:88px;min-height:62px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border-radius:3px;border:1px solid transparent;color:#1a1a1a;text-decoration:none;font-size:12.5px;font-weight:600;text-align:center;line-height:1.15;padding:4px}
.tool .ic{width:26px;height:26px;stroke:var(--mod);fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.tool kbd{margin:0;font-size:10px;border:0;background:none;padding:0}
.tool:hover{background:linear-gradient(180deg,#eaf4fd,#cfe6fa);border-color:#7eb4ea}
.tool.on{background:linear-gradient(180deg,#dcecfc,#c1dcf7);border-color:#569de5;box-shadow:inset 0 1px 2px rgba(0,0,0,.15)}
.tool.main{font-weight:700}
.switch{margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.switch a{display:flex;align-items:center;gap:7px;padding:5px 12px;border:1px solid #adb3bb;border-radius:3px;background:linear-gradient(180deg,#fff,#e5e5e5);color:#1a1a1a;text-decoration:none;font-weight:600;font-size:13px}
.switch a i{width:9px;height:9px;border-radius:2px;background:var(--c)}.switch a:hover{border-color:var(--c)}
main{flex:1;width:100%;padding:16px 20px}h1{font-size:20px;margin:4px 0 12px}h2{font-size:16px;margin:20px 0 8px}
.keyline{position:sticky;bottom:0;z-index:15;display:flex;align-items:center;gap:6px 20px;flex-wrap:wrap;padding:3px 12px;background:#f0f0f0;border-top:1px solid #b9bfc7;font-size:12.5px;color:#333}
.keyline .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--good);margin-right:5px}.keyline .off .dot{background:var(--bad)}
body:has(.fbar) .keyline{display:none}
/* A module's home page: four counts, then one list that fills the screen. */
.mod-counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 14px}
.mod-count{display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--k,var(--muted));border-radius:8px;padding:12px 16px;color:var(--ink);text-decoration:none}
a.mod-count:hover{border-color:var(--mod);border-left-color:var(--k,var(--mod))}
.mod-count span{font-weight:600;color:var(--muted)}.mod-count b{font-size:26px;font-variant-numeric:tabular-nums}
.k-red{--k:var(--bad)}.k-amb{--k:var(--warn)}.k-grn{--k:var(--good)}
.mod-list{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.mod-list h2{margin:0;padding:10px 14px;font-size:15px;display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--line)}
.mod-list h2 a{font-size:13px;font-weight:600;color:var(--mod)}
.mod-list table{border:0}.mod-list .empty{padding:24px 16px;color:var(--muted)}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:1px 9px;border-radius:99px;white-space:nowrap}
.p-red{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}.p-amb{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.p-grn{background:color-mix(in srgb,var(--good) 15%,transparent);color:var(--good)}.p-gry{background:var(--chip);color:var(--muted)}
@media (max-width:900px){.mod-counts{grid-template-columns:repeat(2,minmax(0,1fr))}.switch{display:none}}
@media (max-width:640px){.tool{width:76px;min-height:56px;font-size:11.5px}.titlebar .shop,.titlebar .who{display:none}.menubar{overflow-x:auto}}
.keyline kbd{display:inline-block;margin-right:5px;border:1px solid #b9bfc7;background:#fff;padding:0 4px;border-radius:3px;color:#222;font:600 11px ui-monospace,monospace}
body.framed{--accent:var(--mod)}
`

const css = `
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1d2330;--muted:#5d6676;--line:#dde1e7;--accent:#0d6b5e;--accent-ink:#fff;--warn:#a5530a;--bad:#b42318;--good:#18794e;--chip:#eef1f4}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--panel:#1c2027;--ink:#e6e9ee;--muted:#9aa3b2;--line:#2e343e;--accent:#3fb6a2;--accent-ink:#0b1512;--warn:#e7a35b;--bad:#f07167;--good:#5fd39a;--chip:#262b34}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
${frameCss}
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
.records{max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:8px}.records thead th{position:sticky;top:0;background:var(--panel)}
tr.cur{outline:2px solid var(--accent);outline-offset:-2px;background:color-mix(in srgb,var(--accent) 14%,transparent);font-weight:600}
.tabs{display:flex;gap:4px;margin:16px 0 0;border-bottom:1px solid var(--line)}.tabs a{padding:9px 18px;border-radius:6px 6px 0 0;color:var(--muted);text-decoration:none;font-weight:500}
.tabs a.on{color:var(--ink);background:var(--panel);box-shadow:inset 0 -3px 0 var(--accent);font-weight:600}section.tab{margin-top:8px}section.tab>.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px 16px;align-items:end}
.grid label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}.items-form>.panel>.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px 16px;align-items:end}
.print-only{display:none}.bin-group h2{margin-top:18px}
details.bin-group{margin:6px 0;border:1px solid var(--line);border-radius:8px;background:var(--panel)}details.bin-group>summary{cursor:pointer;padding:10px 14px;font-size:16px;display:flex;gap:12px;align-items:baseline;list-style:none}details.bin-group>summary::-webkit-details-marker{display:none}details.bin-group>summary::before{content:'▸';width:12px;color:var(--muted)}details.bin-group[open]>summary::before{content:'▾'}details.bin-group>summary .bin-name{font-weight:600;min-width:120px}details.bin-group>summary:hover{background:var(--bg)}details.bin-group>.wrap,details.bin-group>table{margin:0 8px 10px}
.move-bar{position:sticky;top:0;z-index:5;gap:10px;align-items:center;flex-wrap:wrap}
@media print{header,.keyline,.noprint,.toolbar,.msg{display:none!important}.print-only{display:block}th.print-only,td.print-only{display:table-cell}
  body{background:#fff;color:#000;font-size:12px}main{max-width:none;padding:0}table{background:#fff}th,td{padding:3px 6px;border-bottom:1px solid #999}
  td.counted,th.counted{width:90px;border-left:1px solid #999}.bin-group{break-inside:auto;border:0}details.bin-group>summary{padding:8px 0 4px;font-size:14px}details.bin-group>summary::before{content:none!important}.bin-group h2{break-after:avoid;font-size:14px}tr{break-inside:avoid}a{color:#000;text-decoration:none}.wrap{overflow:visible}}
@media (max-width:980px){.rx-desk{grid-template-columns:1fr}}
/* Script window (RxWin order): header fields, the line grid, the entry row under it, check and dispense; patient and money on the right. */
.rxw{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:12px;align-items:start}.rxw-main{min-width:0}
.rxw-title{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.rxw-title h1{margin:0}.rxw-title form{margin:0}
.rxw-fields{display:flex;flex-wrap:wrap;gap:10px 18px;margin-top:10px;align-items:flex-end}.rxw-headform{display:contents}
.rxw-f{display:flex;flex-direction:column;gap:3px;min-width:0}.rxw-f>span{font-size:12px;color:var(--muted);font-weight:600}.rxw-f>span kbd{font-size:10px}
.rxw-f #rx-doctor{min-width:200px}.rxw-fields .rxw-f{white-space:nowrap}.rxw-f.grow{flex:1;min-width:240px}.rxw-f .grow{flex:1;min-width:0}
.rxw-lines{padding:0;overflow:hidden}.rxw-lines table{background:none}.rxw-lines thead th{background:color-mix(in srgb,var(--mod,var(--accent)) 8%,var(--panel))}
.rxw-row{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end;margin-bottom:8px}.rxw-acts{align-items:center;margin:4px 0 0}
.rxw-form input,.rxw-form select{font-size:16px;padding:7px 9px}.rxw-form .num{width:84px}.rxw-form .rx-info{margin:0 0 8px;min-height:1.3em}
.rxw-form .rx-instr{min-height:38px;padding:7px 10px;font-size:16px}
.rxw-disp h2{margin:0 0 8px}.rxw-side{position:sticky;top:150px}.rxw{padding-bottom:56px}.rxw-lines th{white-space:nowrap}
button kbd,.btn kbd{background:rgba(255,255,255,.22);border-color:transparent;color:inherit;margin:0 0 0 6px}.secondary kbd{background:var(--panel);border-color:var(--line)}
.fbar kbd{display:inline-block;margin-right:5px;border:1px solid #b9bfc7;background:#fff;padding:0 4px;border-radius:3px;color:#222;font:600 11px ui-monospace,monospace}
body.framed .fbar{background:#f0f0f0;border-top-color:#b9bfc7;padding:5px 14px;font-size:13px;color:#333}
@media (max-width:980px){.rxw{grid-template-columns:1fr}.rxw-side{position:static}}
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
body.touch-mode .tool{width:108px;min-height:78px;font-size:14px}body.touch-mode .menu-list a{padding:11px 18px;font-size:16px}
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
@media (max-width:640px){main{padding:12px 16px}}
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

// Drop-down menus, as in a Windows program: click a heading (or Alt + its underlined letter) to open it,
// move along the bar with the mouse or ← →, through a list with ↑ ↓, Enter opens, Esc closes.
export const menus = `
(()=>{
  const bar=document.querySelector('.menubar');if(!bar)return;
  const all=[...bar.querySelectorAll('.menu')];let open=null;
  const close=()=>{if(open){open.classList.remove('open');open.querySelector('.menu-h').setAttribute('aria-expanded','false');open=null}};
  const show=(m,focus)=>{if(open!==m)close();open=m;m.classList.add('open');m.querySelector('.menu-h').setAttribute('aria-expanded','true');
    if(focus){const a=m.querySelector('.menu-list a');if(a)a.focus()}};
  all.forEach(m=>{const h=m.querySelector('.menu-h');
    h.addEventListener('click',e=>{e.stopPropagation();open===m?close():show(m)});
    h.addEventListener('mouseenter',()=>{if(open&&open!==m)show(m)})});
  document.addEventListener('click',e=>{if(open&&!open.contains(e.target))close()});
  document.addEventListener('keydown',e=>{
    if(e.altKey&&!e.ctrlKey&&e.key.length===1){const m=all.find(x=>x.querySelector('.menu-h').dataset.alt===e.key.toLowerCase());
      if(m){e.preventDefault();e.stopImmediatePropagation();show(m,true)}return}
    if(!open)return;
    const items=[...open.querySelectorAll('.menu-list a')],i=items.indexOf(document.activeElement);
    if(e.key==='Escape'){e.preventDefault();const h=open.querySelector('.menu-h');close();h.focus()}
    else if(e.key==='ArrowDown'){e.preventDefault();e.stopImmediatePropagation();(items[i+1]||items[0]).focus()}
    else if(e.key==='ArrowUp'){e.preventDefault();e.stopImmediatePropagation();(items[i-1]||items[items.length-1]).focus()}
    else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();const n=all.indexOf(open)+(e.key==='ArrowRight'?1:-1);show(all[(n+all.length)%all.length],true)}
  },true);
  const net=document.getElementById('netline');
  const upd=()=>{if(!net)return;net.classList.toggle('off',!navigator.onLine);net.lastChild.textContent=navigator.onLine?'Online':'Offline'};
  addEventListener('online',upd);addEventListener('offline',upd);upd();
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

export function Layout(props: { title: string; user?: SessionUser | null; path?: string; children?: Child; flash?: { ok?: string; err?: string } }) {
  const mods = props.user ? modulesFor(props.user) : []
  const mod = moduleOf(mods, props.path)
  const here = current(mod, props.path)
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · sylken{mod ? ` ${mod.name}` : ''}</title>
        <style>{raw(css)}</style>
      </head>
      <body class={mod ? 'framed' : ''} style={mod ? `--mod:${mod.color}` : ''}>
        {props.user && mod && (
          <header class="frame">
            <div class="titlebar">
              <a class="brand" href={modulePath(mod.slug)}>sylken {mod.name}</a>
              <span class="shop">{props.user.tenantName}</span>
              <span class="spacer" />
              <button type="button" id="touch-toggle" class="tb-btn" title="Bigger buttons for a touch screen">Touch screen</button>
              <a class="who" href="/me" title={props.user.roles.map((r) => roleLabels[r]).join(', ')}>{props.user.name} · {props.user.roles.map((r) => roleLabels[r]).join(', ')}</a>
              <a class="tb-btn" href="/logout">Log out</a>
            </div>
            <MenuBar mod={mod} />
            <Toolbar mod={mod} mods={mods} here={here} />
          </header>
        )}
        <main>
          {props.flash?.err && <div class="msg err">{props.flash.err}</div>}
          {props.flash?.ok && <div class="msg ok">{props.flash.ok}</div>}
          {props.children}
        </main>
        {props.user && mod && (
          <footer class="keyline">{mod.keys.map(([k, l]) => <span><kbd>{k}</kbd>{l}</span>)}<span class="spacer" /><span id="netline"><i class="dot" />Online</span></footer>
        )}
        <script>{raw(keys)}</script>
        <script>{raw(menus)}</script>
        <script>{raw(touch)}</script>
        {props.user && <script>{raw(idleLock)}</script>}
      </body>
    </html>
  )
}

export function StatusChip({ status, reason }: { status: string; reason?: string | null }) {
  return <span class={`st-${status}`} title={reason ?? ''}>{status}</span>
}
