import type { Ctx } from './app.js'
import { can, page, run } from './app.js'
import { dispensaryHome, recentAudit, salesHome, stockHome } from '../domain/home.js'
import { dateTime, homeModule, modulesFor, money, qty, type Module } from './layout.js'

/** A count at the top of a module's home page; a link when there is a list behind it. */
function Count({ label, value, tone, href }: { label: string; value: string | number; tone?: 'red' | 'amb' | 'grn'; href?: string }) {
  const cls = `mod-count${tone ? ` k-${tone}` : ''}`
  const body = <><span>{label}</span><b>{value}</b></>
  return href ? <a class={cls} href={href}>{body}</a> : <div class={cls}>{body}</div>
}

const time = (d: Date) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const stateLabel = { draft: ['Draft', 'red'], unpaid: ['Not paid', 'amb'], owed: ['Owes items', 'amb'], paid: ['Done', 'grn'], reversed: ['Reversed', 'gry'] } as const

async function rxPage(c: Ctx, mod: Module) {
  const h = await run(c, (tx) => dispensaryHome(tx))
  return page(c, mod.name, (
    <>
      <div class="mod-counts">
        <Count label="Drafts to check" value={h.drafts} tone={h.drafts ? 'red' : 'grn'} href="#scripts" />
        <Count label="Owed to patients" value={h.owed} tone={h.owed ? 'amb' : 'grn'} href="/dispensary/owed" />
        <Count label="Repeats due this week" value={h.repeats} tone="grn" href="/reports/rx/repeats" />
        <Count label="Claims not sent (90 days)" value={h.unclaimed} tone={h.unclaimed ? 'red' : 'grn'} href={can(c, 'rx.claims') ? '/dispensary/claims' : undefined} />
      </div>
      <section class="mod-list" id="scripts">
        <h2>Drafts and today's scripts · {h.dispensedToday} dispensed today<a href="/dispensary/scripts">Script book</a></h2>
        {h.scripts.length ? (
          <div class="wrap"><table>
            <thead><tr><th>Script</th><th>Time</th><th>Patient</th><th>Medical aid</th><th class="n">Items</th><th class="n">Total</th><th>Status</th></tr></thead>
            <tbody>{h.scripts.map((s) => (
              <tr data-href={`/dispensary/scripts/${s.id}`}>
                <td><a href={`/dispensary/scripts/${s.id}`}>{s.scriptNo ?? 'draft'}</a></td><td>{time(s.at)}</td><td>{s.patientName}</td>
                <td>{s.medicalAid ?? 'Private'}</td><td class="n">{s.items}</td><td class="n">{money(s.total)}</td>
                <td><span class={`pill p-${stateLabel[s.state][1]}`}>{stateLabel[s.state][0]}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p class="empty">No drafts and no scripts dispensed today. Press <kbd>F5</kbd> or New script to start one.</p>}
      </section>
    </>
  ))
}

async function stockPage(c: Ctx, mod: Module) {
  const h = await run(c, (tx) => stockHome(tx))
  const reports = can(c, 'stock.reports')
  return page(c, mod.name, (
    <>
      <div class="mod-counts">
        <Count label="Selling but out of stock" value={h.outSelling} tone={h.outSelling ? 'red' : 'grn'} href="#order" />
        <Count label="At or below minimum" value={h.belowMin} tone={h.belowMin ? 'amb' : 'grn'} href={reports ? '/reports/minmax' : undefined} />
        <Count label="Negative stock" value={h.negative} tone={h.negative ? 'red' : 'grn'} href={reports ? '/reports/negative' : undefined} />
        <Count label="Stock at cost" value={money(h.valueCost)} href={reports ? '/reports/valuation' : undefined} />
      </div>
      <section class="mod-list" id="order">
        <h2>Order first: items sold in the last 90 days that are out or below minimum{reports && <a href="/reports/minmax">Order list</a>}</h2>
        {h.items.length ? (
          <div class="wrap"><table>
            <thead><tr><th>Code</th><th>Item</th><th class="n">On hand</th><th class="n">Minimum</th><th class="n">Sold, 90 days</th><th class="n">Cost a pack</th></tr></thead>
            <tbody>{h.items.map((i) => (
              <tr data-href={`/items/${i.id}`}>
                <td>{i.stockCode}</td><td><a href={`/items/${i.id}`}>{i.description}</a></td>
                <td class={`n${i.onHand < 0 ? ' neg' : ''}`}>{qty(i.onHand, i.packSize)}</td><td class="n">{i.minUnits === null ? '' : qty(Math.round(i.minUnits), i.packSize)}</td>
                <td class="n">{qty(i.sold90, i.packSize)}</td><td class="n">{money(i.costPerPack)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p class="empty">Nothing that sells is out of stock or below its minimum.</p>}
      </section>
    </>
  ))
}

async function tillPage(c: Ctx, mod: Module) {
  const sales = can(c, 'sales.view')
  const h = await run(c, (tx) => salesHome(tx))
  const audit = can(c, 'audit.view') ? await run(c, (tx) => recentAudit(tx, 12)) : []
  return page(c, mod.name, (
    <>
      <div class="mod-counts">
        {sales
          ? <Count label={`Sales today (${h.salesCount})`} value={money(h.salesToday)} href="/sales" />
          : <Count label="Open the till" value="F9" href="/till/" />}
        <Count label="Till runs open" value={h.openRuns} tone={h.openRuns ? 'amb' : 'grn'} href="/cashup" />
        <Count label="Scripts not paid (30 days)" value={h.scriptsUnpaid} tone={h.scriptsUnpaid ? 'amb' : 'grn'} />
        <Count label="Accounts over their limit" value={h.overLimit} tone={h.overLimit ? 'red' : 'grn'} href="/accounts" />
      </div>
      {sales ? (
        <section class="mod-list">
          <h2>Today's sales · GP {money(h.gpToday)}<a href="/sales">Sales journal</a></h2>
          {h.sales.length ? (
            <div class="wrap"><table>
              <thead><tr><th>Sale</th><th>Time</th><th>Kind</th><th>Script</th><th>Assistant</th><th class="n">Total</th></tr></thead>
              <tbody>{h.sales.map((s) => (
                <tr><td>{s.saleNo}</td><td>{time(s.at)}</td><td>{s.kind === 'refund' ? <span class="pill p-amb">Refund</span> : 'Sale'}</td>
                  <td>{s.scriptNo ?? ''}</td><td>{s.who ?? ''}</td><td class={`n${s.total < 0 ? ' neg' : ''}`}>{money(s.total)}</td></tr>
              ))}</tbody>
            </table></div>
          ) : <p class="empty">No sales yet today. Press <kbd>F9</kbd> or Invoicing to open the till.</p>}
        </section>
      ) : <section class="mod-list"><p class="empty">Press <kbd>F9</kbd> or Invoicing to open the till, and <kbd>F10</kbd> to cash up at the end of your shift.</p></section>}
      {audit.length > 0 && (
        <section class="mod-list" style="margin-top:14px">
          <h2>Latest in the audit trail<a href="/reports/till/audit">Audit trail</a></h2>
          <div class="wrap"><table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>On</th></tr></thead>
            <tbody>{audit.map((a) => <tr><td>{dateTime(a.at)}</td><td>{a.who ?? ''}</td><td>{a.action}</td><td>{a.entity}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
    </>
  ))
}

/** A module's home page, or 404 when the person may not open that module. */
export async function modulePage(c: Ctx, slug?: string) {
  const user = c.get('user')
  const mod = slug ? modulesFor(user).find((m) => m.slug === slug) : homeModule(user)
  if (!mod) return c.notFound()
  if (mod.slug === 'rx') return rxPage(c, mod)
  if (mod.slug === 'stock') return stockPage(c, mod)
  return tillPage(c, mod)
}
