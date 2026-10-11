import { Hono } from 'hono'
import { DomainError } from '../domain/errors.js'
import { listSales, salesSummary, shopToday } from '../domain/sales.js'
import { getSettings } from '../domain/settings.js'
import { denominations } from '../domain/basket.js'
import { closeRun, createTill, getZReport, listTills, runSummary, tenderLabels, type Tender } from '../domain/till.js'
import { back, can, page, run, type Ctx, type Env } from './app.js'
import { dateTime, money } from './layout.js'

/** Today in the shop's time zone, or the from/to in the query; a report can start on another default. */
export async function rangeFrom(c: Ctx, dflt?: (today: string) => { from: string; to: string }) {
  const tz = (await run(c, getSettings)).timezone
  const today = shopToday(tz)
  const d = dflt ? dflt(today) : { from: today, to: today }
  const from = c.req.query('from') || (c.req.query('to') ? c.req.query('to')! : d.from)
  return { from, to: c.req.query('to') || (c.req.query('from') ? from : d.to), today }
}

/** YYYY-MM-DD plus or minus days. */
export const shiftDay = (iso: string, days: number) => new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400_000).toISOString().slice(0, 10)
/** The first of the month the date falls in. */
export const monthStart = (iso: string) => iso.slice(0, 8) + '01'
export const thisMonth = (today: string) => ({ from: monthStart(today), to: today })

const signed = (n: number | null) => (n === null ? '' : <span class={n < 0 ? 'neg' : n > 0 ? 'pos' : ''}>{money(n)}</span>)

export function RangeForm(props: { from: string; to: string; today: string; extra?: any; keep?: string }) {
  const k = props.keep ? `&${props.keep}` : ''
  const lastEnd = shiftDay(monthStart(props.today), -1)
  return (
    <form class="row panel">
      <label class="f">From<input type="date" name="from" value={props.from} /></label>
      <label class="f">To<input type="date" name="to" value={props.to} /></label>
      {props.extra}
      <button class="secondary">Show</button>
      <a class="btn secondary" href={`?from=${props.today}&to=${props.today}${k}`}>Today</a>
      <a class="btn secondary" href={`?from=${monthStart(props.today)}&to=${props.today}${k}`}>This month</a>
      <a class="btn secondary" href={`?from=${monthStart(lastEnd)}&to=${lastEnd}${k}`}>Last month</a>
    </form>
  )
}

export function cashupRoutes() {
  const r = new Hono<Env>()

  /** POSWin's Sales Summary: cash analysis per run, then payments, bank deposit and turnover. */
  r.get('/', async (c) => {
    const range = await rangeFrom(c)
    const tillId = c.req.query('till') || undefined
    const { sum, tills, open, problems } = await run(c, async (tx) => ({
      sum: await salesSummary(tx, { from: range.from, to: range.to, tillId }),
      tills: await listTills(tx),
      open: await tx`select r.id, r.run_no, r.opened_at, t.code from till_runs r join tills t on t.id = r.till_id where r.status = 'open' order by r.opened_at`,
      problems: Number((await tx`select count(*) from till_rejects where not resolved`)[0].count),
    }))
    const { payments: p, bank, turnover } = sum
    const totals = sum.rows.reduce((a, x) => ({
      cash: a.cash + x.cash, card: a.card + x.card, cheque: a.cheque + x.cheque, totalTill: a.totalTill + x.totalTill,
      counted: a.counted + (x.counted ?? 0), surplus: a.surplus + (x.surplus ?? 0), directBank: a.directBank + x.directBank,
    }), { cash: 0, card: 0, cheque: 0, totalTill: 0, counted: 0, surplus: 0, directBank: 0 })
    return page(c, 'Cash-up', (
      <>
        <div class="row"><h1>Cash-up and sales summary</h1><span class="spacer" /><a class="btn" href="/till/">Open the till (F9)</a></div>
        {problems > 0 && <div class="msg err"><a href="/cashup/problems">{problems} till record(s) could not be recorded</a> and need checking.</div>}
        {open.length > 0 && (
          <div class="panel">
            <b>Runs still open:</b>{' '}
            {open.map((o: any) => <a class="chip" href={`/cashup/runs/${o.id}`}>Run {o.run_no} · {o.code} · since {dateTime(o.opened_at)}</a>)}
            <span class="hint"> Open a run to cash it up.</span>
          </div>
        )}
        <RangeForm {...range} extra={
          <label class="f">Till<select name="till"><option value="">All tills</option>{tills.map((t) => <option value={t.id} selected={t.id === tillId}>{t.name} ({t.code})</option>)}</select></label>
        } />
        {sum.warnings.map((w) => <div class="msg err">{w}</div>)}
        <h2>Cash analysis</h2>
        <div class="wrap"><table>
          <thead><tr><th>Till</th><th>Run</th><th class="n">Cash</th><th class="n">Card</th><th class="n">Cheques</th><th class="n">Total till</th>
            <th class="n">Counted</th><th class="n">Surplus</th><th class="n">Direct bank</th><th>Assistants</th></tr></thead>
          <tbody>{sum.rows.map((x) => (
            <tr data-href={`/cashup/runs/${x.run.id}`}>
              <td>{x.run.tillCode}</td><td><a href={`/cashup/runs/${x.run.id}`}>{x.run.runNo}</a>{x.run.status === 'open' && <span class="muted"> (open)</span>}</td>
              <td class="n">{money(x.cash)}</td><td class="n">{money(x.card)}</td><td class="n">{money(x.cheque)}</td><td class="n">{money(x.totalTill)}</td>
              <td class="n">{x.counted === null ? <span class="muted">not counted</span> : money(x.counted)}</td><td class="n">{signed(x.surplus)}</td>
              <td class="n">{money(x.directBank)}</td><td>{x.run.assistants.join(', ')}</td>
            </tr>
          ))}</tbody>
          <tfoot><tr><td colspan={2}><b>Total</b></td><td class="n">{money(totals.cash)}</td><td class="n">{money(totals.card)}</td><td class="n">{money(totals.cheque)}</td>
            <td class="n"><b>{money(totals.totalTill)}</b></td><td class="n">{money(totals.counted)}</td><td class="n">{signed(Math.round(totals.surplus * 100) / 100)}</td>
            <td class="n">{money(totals.directBank)}</td><td /></tr></tfoot>
        </table></div>
        <p class="hint">Cash is what the drawer took (sales and account payments less petty cash), without the float. Counted is the cash counted less the opening float, plus card slips and cheques.</p>
        <div class="blocks">
          <div class="block"><h3>Payments</h3>
            <table class="sumtab">
              <tr><td>Cash sales</td><td class="n">{money(p.cashSales)}</td></tr>
              <tr><td>+ Account payments</td><td class="n">{money(p.accountPayments)}</td></tr>
              <tr><td>+ Medical aid</td><td class="n">{money(p.medAid)}</td></tr>
              <tr class="t"><td>= Total</td><td class="n">{money(p.total)}</td></tr>
              <tr><td>− Medical aid</td><td class="n">{money(p.lessMedAid)}</td></tr>
              <tr><td>− Petty cash</td><td class="n">{money(p.lessPettyCash)}</td></tr>
              <tr class="t"><td>= Total</td><td class="n">{money(p.subtotal)}</td></tr>
              <tr><td>− Direct banking</td><td class="n">{money(p.lessDirectBank)}</td></tr>
              <tr class="t"><td><b>= Total payments</b></td><td class="n"><b>{money(p.totalPayments)}</b></td></tr>
            </table>
          </div>
          <div class="block"><h3>Bank deposit</h3>
            <table class="sumtab">
              <tr><td>Credit card</td><td class="n">{money(bank.creditCard)}</td></tr>
              <tr><td>+ Deposit amount</td><td class="n">{money(bank.depAmount)}</td></tr>
              <tr class="t"><td>= Total</td><td class="n">{money(bank.total)}</td></tr>
              <tr><td><b>Surplus</b></td><td class="n"><b>{signed(bank.surplus)}</b></td></tr>
            </table>
            {bank.runsNotCounted > 0 && <p class="hint">{bank.runsNotCounted} run(s) not counted yet are left out.</p>}
          </div>
          <div class="block"><h3>Turnover</h3>
            <table class="sumtab">
              <tr><td>Cash sales</td><td class="n">{money(turnover.cashSales)}</td></tr>
              <tr><td>+ Account sales</td><td class="n">{money(turnover.accountSales)}</td></tr>
              <tr><td>+ Medical aid</td><td class="n">{money(turnover.medicalFund)}</td></tr>
              <tr class="t"><td><b>= Total</b></td><td class="n"><b>{money(turnover.total)}</b></td></tr>
            </table>
          </div>
        </div>
        <p class="hint">Cash sales means everything paid at the till: cash, card, cheque and EFT. Deposit amount is the cash counted less the opening float, plus cheques.</p>
        <h2>Tills</h2>
        <div class="wrap"><table>
          <thead><tr><th>Code</th><th>Name</th><th>Last heard from</th><th class="n">Still to send then</th><th class="n">Open runs</th></tr></thead>
          <tbody>{tills.map((t) => (
            <tr><td>{t.code}</td><td>{t.name}</td><td>{t.lastSeenAt ? dateTime(t.lastSeenAt) : <span class="muted">never</span>}</td>
              <td class="n">{t.lastPending ?? ''}</td><td class="n">{t.openRuns}</td></tr>
          ))}</tbody>
        </table></div>
        <form method="post" action="/cashup/tills" class="row panel" style="margin-top:8px">
          <label class="f">New till code<input name="code" placeholder="T2" required maxlength={8} /></label>
          <label class="f">Name<input name="name" placeholder="Till 2 (front counter)" required /></label>
          <button class="secondary">Add till</button>
        </form>
        <p class="hint">Before cashing up, check each till shows nothing still to send. A sale that reaches the server after its run is cashed up is kept and flagged on the run.</p>
      </>
    ))
  })

  r.post('/tills', async (c) => {
    const b = await c.req.parseBody()
    await run(c, (tx) => createTill(tx, { code: String(b.code ?? ''), name: String(b.name ?? '') }, c.get('user').userId))
    return back(c, '/cashup', { ok: 'Till added. Choose it on the till screen of that computer.' })
  })

  r.get('/runs/:id', async (c) => {
    const blind = !can(c, 'cashup.manage')
    const { s, sales, entries, events, defaultFloat } = await run(c, async (tx) => {
      const s = await runSummary(tx, c.req.param('id'))
      if (!s) throw new DomainError('unknown till run', 'not_found', 404)
      return {
        s,
        sales: await listSales(tx, { runId: s.id }),
        entries: await tx`
          select e.*, a.name as account_name, u.name as user_name from till_entries e
            left join customer_accounts a on a.id = e.account_id left join users u on u.id = e.user_id
           where e.till_run_id = ${s.id} order by e.occurred_at`,
        events: await tx`
          select e.*, u.name as approver from till_events e left join till_approvals a on a.id = e.approval_id left join users u on u.id = a.approved_by
           where e.till_run_id = ${s.id} order by e.occurred_at`,
        defaultFloat: (await getSettings(tx)).defaultFloat,
      }
    })
    const tenderRows = (Object.keys(s.byTender) as Tender[]).filter((t) => s.byTender[t] !== 0)
    // Assistants count their drawer blind: what the system expects shows once the run is cashed up.
    const hide = blind && s.status === 'open'
    return page(c, `Run ${s.runNo}`, (
      <>
        <h1>Run {s.runNo} · {s.tillName} ({s.tillCode}) <span class="muted">{s.status === 'open' ? 'open' : 'cashed up'}</span></h1>
        <p class="muted">Opened {dateTime(s.openedAt)}{s.openedBy && ` by ${s.openedBy}`}{s.cashier && `, drawer cashier ${s.cashier}`}, with a float of {money(s.openingFloat)} counted.
          {!hide && s.expectedFloat !== null && s.expectedFloat !== s.openingFloat && ` The last run left ${money(s.expectedFloat)} (${money(s.openingFloat - s.expectedFloat)} difference).`}
          {s.closedAt && ` Cashed up ${dateTime(s.closedAt)}${s.closedBy ? ` by ${s.closedBy}` : ''}; ${money(s.floatKept)} left in the drawer.`}</p>
        {s.zReport && <p><a class="btn secondary" href={`/cashup/runs/${s.id}/z`}>Z report {s.zReport.zNo}</a></p>}
        {s.late.count > 0 && <div class="msg err">{s.late.count} sale(s) or entries reached the server after this run was cashed up ({money(s.late.total)} in sales). They are included below, so the surplus now shows them.</div>}
        <div class="stats">
          <div class="stat"><b>{s.sales.count}</b><span>sales{s.sales.refunds ? `, ${s.sales.refunds} refunds` : ''}</span></div>
          {!hide && <div class="stat"><b>{money(s.sales.total)}</b><span>takings incl VAT ({money(s.sales.vat)} VAT){s.sales.rounding !== 0 && `, cash rounding ${money(s.sales.rounding)}`}</span></div>}
          <div class="stat"><b>{money(s.pettyCash)}</b><span>petty cash paid out</span></div>
          {s.cashDrops > 0 && <div class="stat"><b>{money(s.cashDrops)}</b><span>cash drops to the safe</span></div>}
          {(s.events.noSales > 0 || s.events.voids > 0) && <div class="stat"><b>{s.events.noSales} / {s.events.voids}</b><span>no-sales / voids</span></div>}
          {s.surplus !== null && <div class="stat"><b class={s.surplus < 0 ? 'neg' : s.surplus > 0 ? 'pos' : ''}>{money(s.surplus)}</b><span>{s.surplus < 0 ? 'short' : s.surplus > 0 ? 'over' : 'balanced'}</span></div>}
        </div>
        {!hide && (
          <>
            <h2>By tender</h2>
            <div class="wrap"><table>
              <thead><tr><th>Tender</th><th class="n">Sales</th><th class="n">Account payments</th></tr></thead>
              <tbody>{tenderRows.map((t) => (
                <tr><td>{tenderLabels[t]}</td><td class="n">{money(s.byTender[t])}</td><td class="n">{t in s.accountPayments ? money((s.accountPayments as any)[t]) : ''}</td></tr>
              ))}
              {(['cash', 'card', 'cheque', 'eft'] as const).filter((t) => s.byTender[t] === 0 && s.accountPayments[t] !== 0).map((t) => (
                <tr><td>{tenderLabels[t]}</td><td class="n">{money(0)}</td><td class="n">{money(s.accountPayments[t])}</td></tr>
              ))}</tbody>
            </table></div>
          </>
        )}
        {s.status === 'closed' ? (
          <>
            <h2>Cash-up</h2>
            <div class="wrap"><table>
              <thead><tr><th>Tender</th><th class="n">Expected</th><th class="n">Counted</th><th class="n">Variance</th></tr></thead>
              <tbody>{s.counts.map((x) => <tr><td>{tenderLabels[x.tender]}</td><td class="n">{money(x.expected)}</td><td class="n">{money(x.counted)}</td><td class="n">{signed(x.surplus)}</td></tr>)}
                <tr><td>{tenderLabels.eft}</td><td class="n">{money(s.expected.eft)}</td><td class="n muted" colspan={2}>check against the bank statement</td></tr>
              </tbody>
            </table></div>
            <p class="hint">Cash variance = cash counted − (opening float {money(s.openingFloat)} + net cash {money(s.netCash)} − cash drops {money(s.cashDrops)}).</p>
            {s.cashCount.length > 0 && <p class="muted">Counted: {s.cashCount.map((d) => `${d.qty} × ${money(d.denomination)}`).join(', ')}.</p>}
            {s.note && <p>Note: {s.note}</p>}
          </>
        ) : (
          <>
            <h2>Cash up this run</h2>
            <form method="post" action={`/cashup/runs/${s.id}/close`} class="panel">
              <p class="hint">Count blind: type how many of each note and coin are in the drawer, including the float. What the system expects is shown once you have cashed up.</p>
              <div class="cgrid">
                {denominations.map((d, i) => (
                  <label>{money(d)} {d >= 10 ? 'notes' : 'coins'}<input name={`d_${d}`} type="number" step="1" min="0" inputmode="numeric" placeholder="0" autofocus={i === 0} /></label>
                ))}
              </div>
              <div class="cgrid" style="margin-top:8px">
                <label>{tenderLabels.card} batch total (P)<input name="card" type="number" step="0.01" min="0" required /></label>
                <label>{tenderLabels.cheque} total (P)<input name="cheque" type="number" step="0.01" min="0" required /></label>
                <label>Float left in the drawer (P)<input name="floatKept" type="number" step="0.01" min="0" value={(defaultFloat || s.openingFloat).toFixed(2)} required /></label>
                <label style="grid-column:1/-1">Note<input name="note" placeholder="Anything the owner should know" /></label>
              </div>
              <div class="row" style="margin-top:8px">
                <span class="hint">Add up the card machine's batch total and any cheques. EFT is checked on the bank statement instead.</span>
                <span class="spacer" /><button>Cash up and close the run</button>
              </div>
            </form>
            <p class="hint">Make sure the till shows nothing waiting to send before cashing up, or late sales will show as a shortage on this run. Once cashed up, the run and its Z report are locked.</p>
          </>
        )}
        {!hide && events.length > 0 && (
          <>
            <h2>No-sales, voids and price warnings</h2>
            <div class="wrap"><table>
              <thead><tr><th>Time</th><th>What</th><th>Cashier</th><th>Allowed by</th><th class="n">Amount</th></tr></thead>
              <tbody>{events.map((e: any) => (
                <tr><td>{dateTime(e.occurred_at)}</td>
                  <td>{e.priority === 'high' && <span class="neg">! </span>}{e.kind === 'no_sale' ? `No sale: ${e.reason}` : e.kind === 'void' ? `Void: ${e.detail?.description ?? ''}${e.detail?.units ? ` × ${e.detail.units}` : ''}` : `List price not the item's price (line ${e.detail?.lineNo})`}</td>
                  <td>{e.cashier_code}</td><td>{e.approver ?? ''}</td><td class="n">{e.detail?.lineTotal !== undefined ? money(Number(e.detail.lineTotal)) : e.detail?.listTotal !== undefined ? money(Number(e.detail.listTotal)) : ''}</td></tr>
              ))}</tbody>
            </table></div>
          </>
        )}
        {entries.length > 0 && (
          <>
            <h2>Petty cash, cash drops and account payments</h2>
            <div class="wrap"><table>
              <thead><tr><th>Time</th><th>What</th><th>Tender</th><th class="n">Amount</th><th>By</th></tr></thead>
              <tbody>{entries.map((e: any) => (
                <tr><td>{dateTime(e.occurred_at)}</td>
                  <td>{e.kind === 'petty_cash' ? `Petty cash: ${e.note}` : e.kind === 'cash_drop' ? `Cash drop, ${e.note}` : <>Payment from <a href={`/accounts/${e.account_id}`}>{e.account_name}</a></>}{e.late && <span class="neg"> (late)</span>}</td>
                  <td>{tenderLabels[e.tender as Tender]}</td><td class="n">{money(Number(e.amount))}</td><td>{e.user_name}</td></tr>
              ))}</tbody>
            </table></div>
          </>
        )}
        {!hide && <><h2>Sales</h2><SalesTable sales={sales} /></>}
      </>
    ))
  })

  r.post('/runs/:id/close', async (c) => {
    const b = await c.req.parseBody()
    const n = (k: string) => (String(b[k] ?? '').trim() === '' ? NaN : Number(b[k]))
    // Notes and coins: an empty box means none of that one.
    const cash = Object.fromEntries(denominations.map((d) => [String(d), String(b[`d_${d}`] ?? '').trim() === '' ? 0 : Number(b[`d_${d}`])]))
    const s = await run(c, (tx) => closeRun(tx, c.req.param('id'), {
      cash, counted: { card: n('card'), cheque: n('cheque') }, floatKept: n('floatKept'), note: String(b.note ?? ''),
    }, c.get('user').userId))
    const msg = s.surplus === 0 ? 'Cashed up: the run balances.' : `Cashed up: ${money(Math.abs(s.surplus!))} ${s.surplus! < 0 ? 'short' : 'over'}.`
    return back(c, `/cashup/runs/${s.id}`, { ok: msg })
  })

  /** The Z report of a cashed-up run: a fixed summary, numbered, that never changes. */
  r.get('/runs/:id/z', async (c) => {
    const z = await run(c, (tx) => getZReport(tx, c.req.param('id')))
    if (!z) throw new DomainError('this run has no Z report yet; it is made when the run is cashed up', 'not_found', 404)
    const p = z.payload
    const row = (label: string, v: any) => <tr><td>{label}</td><td class="n">{v}</td></tr>
    return page(c, `Z report ${z.zNo}`, (
      <>
        <div class="row"><h1>Z report {z.zNo}</h1><span class="spacer" /><button class="secondary" onclick="window.print()">Print</button></div>
        <p class="muted">{p.till.name} ({p.till.code}) · run {p.shift.runNo} · {dateTime(new Date(p.shift.openedAt))} to {dateTime(new Date(p.shift.closedAt))}{p.cashier && ` · cashier ${p.cashier}`}{p.closedBy && ` · cashed up by ${p.closedBy}`}</p>
        <div class="blocks">
          <div class="block"><h3>Sales</h3><table class="sumtab">
            {row('Sales', p.sales.count)}{row('Refunds', `${p.sales.refunds} · ${money(p.sales.refundTotal)}`)}
            {row('Net takings incl VAT', money(p.sales.net))}{row('VAT', money(p.sales.vat))}{row('Cash rounding', money(p.sales.rounding))}
            {row('Discounts', `${p.discounts.lines} line(s) · ${money(p.discounts.total)}`)}{row('Prices changed', `${p.priceOverrides.lines} line(s) · ${money(p.priceOverrides.total)}`)}
            {row('Voids', `${p.voids.count} · ${money(p.voids.total)}`)}{row('No-sales', p.noSales)}
          </table></div>
          <div class="block"><h3>VAT by rate</h3><table class="sumtab">
            {p.vatByRate.map((v: any) => row(`${(v.rate * 100).toFixed(0)}%: ${money(v.net)} + VAT`, money(v.vat)))}
          </table></div>
          <div class="block"><h3>Tenders</h3><table class="sumtab">
            {(Object.keys(p.tenders) as Tender[]).filter((t) => p.tenders[t] !== 0).map((t) => row(tenderLabels[t], money(p.tenders[t])))}
          </table></div>
          <div class="block"><h3>Cash</h3><table class="sumtab">
            {row('Opening float', money(p.cash.openingFloat))}{row('+ Net cash', money(p.cash.netCash))}{row('− Cash drops', money(p.cash.cashDrops))}
            {row('= Expected', money(p.cash.expected))}{row('Counted', p.cash.counted === null ? '' : money(p.cash.counted))}
            <tr class="t"><td><b>Variance</b></td><td class="n"><b>{p.cash.variance === null ? '' : signed(p.cash.variance)}</b></td></tr>
            {row('Float left', money(p.cash.floatKept))}
          </table></div>
        </div>
        <p class="hint">Sent to accounting: {z.exportStatus === 'sent' ? 'yes' : 'not yet. No accounting system or central server is linked to sylken yet, so this report waits in the outbox.'}</p>
      </>
    ))
  })

  r.get('/problems', async (c) => {
    const rows = await run(c, (tx) => tx`
      select r.id, r.op, r.error, r.at, r.resolved, t.code from till_rejects r left join tills t on t.id = r.till_id
       order by r.resolved, r.at desc limit 200`)
    return page(c, 'Till problems', (
      <>
        <h1>Till records the server could not take</h1>
        <p class="muted">When a till sends something that doesn't make sense (for example a sale whose payments don't add up), it is kept here instead of being lost. Ring up a correction if needed, then mark it sorted.</p>
        <div class="wrap"><table>
          <thead><tr><th>When</th><th>Till</th><th>What</th><th>Problem</th><th></th></tr></thead>
          <tbody>{rows.map((x: any) => (
            <tr><td>{dateTime(x.at)}</td><td>{x.code}</td>
              <td><details><summary>{x.op?.type ?? 'unknown'} {x.op?.data?.lines ? `· ${x.op.data.lines.length} line(s)` : ''}</summary><pre style="white-space:pre-wrap;font-size:12px">{JSON.stringify(x.op, null, 2)}</pre></details></td>
              <td>{x.error}</td>
              <td>{x.resolved ? <span class="muted">sorted</span> : <form method="post" action={`/cashup/problems/${x.id}/resolve`}><button class="secondary">Mark sorted</button></form>}</td></tr>
          ))}</tbody>
        </table></div>
      </>
    ))
  })

  r.post('/problems/:id/resolve', async (c) => {
    await run(c, (tx) => tx`update till_rejects set resolved = true where id = ${c.req.param('id')}`)
    return back(c, '/cashup/problems', { ok: 'Marked as sorted' })
  })

  return r
}

export function SalesTable(props: { sales: Awaited<ReturnType<typeof listSales>> }) {
  return (
    <div class="wrap"><table>
      <thead><tr><th>No</th><th>Time</th><th>Till / run</th><th>Assistant</th><th>Paid by</th><th>Customer</th><th class="n">Discount</th><th class="n">Total</th></tr></thead>
      <tbody>{props.sales.map((s) => (
        <tr data-href={`/sales/${s.id}`}><td><a href={`/sales/${s.id}`}>{s.saleNo}</a>{s.kind === 'refund' && <span class="neg"> refund</span>}{s.late && <span class="neg"> late</span>}</td>
          <td>{dateTime(s.occurredAt)}</td><td>{s.tillCode} / {s.runNo}</td><td>{s.userName}</td>
          <td>{s.tenders.split(', ').map((t) => tenderLabels[t as Tender] ?? t).join(', ')}</td><td>{s.accountName ?? s.medicalAid ?? ''}</td>
          <td class="n">{s.discount ? money(s.discount) : ''}</td><td class="n">{money(s.total)}</td></tr>
      ))}</tbody>
    </table></div>
  )
}
