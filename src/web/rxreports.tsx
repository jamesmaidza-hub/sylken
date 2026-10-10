import { Hono } from 'hono'
import { listMedicalAids, ageOn } from '../domain/patients.js'
import {
  drugUsage, lastVisit, patientList, priceChanges, priceSources, repeatsDue, reversedScripts, scriptAnalysis, type AnalysisBy,
} from '../domain/rxreports.js'
import { page, run, type Env } from './app.js'
import { rangeFrom, shiftDay, thisMonth } from './cashup.js'
import { RxToolbar } from './dispensary.js'
import { download } from './export.js'
import { file, ReportPage, type ReportProps, type ScreenCol } from './report.js'
import { date, dateTime, money, qty } from './layout.js'

const Report = <T,>(props: Omit<ReportProps<T>, 'toolbar'>) => <ReportPage {...props} toolbar={<RxToolbar on="reports" />} />

export const rxReportList: [string, string, string][] = [
  ['/reports/rx/drug-usage', 'Drug usage', 'Each medicine dispensed: scripts, patients, quantity, value and GP'],
  ['/reports/rx/scripts', 'Script analysis', 'Scripts per day: new and repeat, items, value, claims and GP'],
  ['/reports/rx/scripts?by=aid', 'Medical aids', 'Scripts and value per medical aid, and private'],
  ['/reports/rx/scripts?by=doctor', 'Doctors', 'Scripts and value per prescribing doctor'],
  ['/reports/rx/scripts?by=dispenser', 'Dispensers', 'Scripts and value per pharmacist who dispensed them'],
  ['/dispensary/scripts', 'Script book', 'Every script dispensed, by number'],
  ['/dispensary/register', 'Schedule register', 'Scheduled medicines in and out, with running balance'],
  ['/reports/rx/patients', 'Patients', 'Patients seen, with medical aid, doctor, allergies and spend'],
  ['/reports/rx/last-visit', 'Last patient visit', 'Patients not seen since, longest gone first'],
  ['/reports/rx/repeats', 'Repeats not collected', 'Repeats due that have not been filled, with phone numbers'],
  ['/dispensary/owed', 'Owed items', 'What dispensed scripts still owe patients'],
  ['/reports/rx/price-changes', 'Price changes', 'Cost and selling price changes, before and after'],
  ['/reports/rx/reversed', 'Reversed scripts', 'Scripts reversed, why and by whom'],
]

export function rxReportRoutes() {
  const r = new Hono<Env>()

  r.get('/', (c) => page(c, 'Dispensary reports', (
    <>
      <RxToolbar on="reports" />
      <h1>Dispensary reports</h1>
      <p class="muted">Each report takes a date range and downloads to Excel or CSV. Claims reports come with medical aid claiming.</p>
      <div class="stats">
        {rxReportList.map(([href, title, desc]) => <a class="stat" href={href}><b style="font-size:16px">{title}</b><span>{desc}</span></a>)}
      </div>
    </>
  )))

  // ------------------------------------------------------------ drug usage

  r.get('/drug-usage', async (c) => {
    const range = await rangeFrom(c, thisMonth)
    const sch = c.req.query('schedule') ?? ''
    const q = (c.req.query('q') ?? '').trim()
    const rows = await run(c, (tx) => drugUsage(tx, range, { schedule: sch === '' ? undefined : Number(sch), q: q || undefined }))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Code', v: (x) => x.stockCode },
      { h: 'NAPPI', v: (x) => x.nappiCode },
      { h: 'Description', v: (x) => x.description },
      { h: 'Schedule', v: (x) => x.schedule, fmt: 'int' },
      { h: 'Scripts', v: (x) => x.scripts, fmt: 'int' },
      { h: 'Patients', v: (x) => x.patients, fmt: 'int' },
      { h: 'Units', v: (x) => x.units, fmt: 'int' },
      { h: 'Packs', v: (x) => +(x.units / x.packSize).toFixed(3), fmt: 'qty' },
      { h: 'Value incl VAT', v: (x) => x.total, fmt: 'money' },
      { h: 'Excl VAT', v: (x) => x.excl, fmt: 'money' },
      { h: 'Cost', v: (x) => x.cost, fmt: 'money' },
      { h: 'GP', v: (x) => x.gp, fmt: 'money', show: (x) => <span class={x.gp < 0 ? 'neg' : ''}>{money(x.gp)}</span> },
      { h: 'GP %', v: (x) => x.gpPct, fmt: 'pct' },
    ]
    const dl = await download(c, file('drug-usage', range), 'Drug usage', cols, rows)
    if (dl) return dl
    const t = rows.reduce((a, x) => ({ total: a.total + x.total, gp: a.gp + x.gp, excl: a.excl + x.excl }), { total: 0, gp: 0, excl: 0 })
    return page(c, 'Drug usage', <Report c={c} title="Drug usage" range={range} cols={cols} rows={rows}
      intro="Every medicine on a dispensed script in the range, biggest value first. Quantity is what was charged on the script, owed items included."
      keep={[sch && `schedule=${sch}`, q && `q=${encodeURIComponent(q)}`].filter(Boolean).join('&')}
      filters={<>
        <label class="f">Schedule<select name="schedule"><option value="">All</option>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => <option value={String(n)} selected={sch === String(n)}>Schedule {n}</option>)}</select></label>
        <label class="f">Item<input name="q" value={q} placeholder="Name or code" /></label>
      </>}
      summary={`${rows.length} medicines dispensed for ${money(t.total)} incl VAT, GP ${money(t.gp)}${t.excl ? ` (${((t.gp / t.excl) * 100).toFixed(1)}%)` : ''} excl VAT.`}
      href={(x) => `/items/${x.itemId}`} />)
  })

  // ------------------------------------------------------------ script analysis, medical aids, doctors, dispensers

  r.get('/scripts', async (c) => {
    const by = (['day', 'aid', 'doctor', 'dispenser'].includes(c.req.query('by') ?? '') ? c.req.query('by') : 'day') as AnalysisBy
    const range = await rangeFrom(c, thisMonth)
    const { rows, totals } = await run(c, (tx) => scriptAnalysis(tx, range, by))
    type R = (typeof rows)[number]
    const heading = { day: 'Date', aid: 'Medical aid', doctor: 'Doctor', dispenser: 'Dispensed by' }[by]
    const title = { day: 'Script analysis', aid: 'Medical aids', doctor: 'Doctors', dispenser: 'Dispensers' }[by]
    const cols: ScreenCol<R>[] = [
      { h: heading, v: (x) => x.key, show: (x) => (by === 'day' && x.key !== 'Total' ? date(x.key) : x.key) },
      { h: 'Scripts', v: (x) => x.scripts, fmt: 'int' },
      { h: 'New', v: (x) => x.newScripts, fmt: 'int' },
      { h: 'Repeats', v: (x) => x.repeats, fmt: 'int' },
      { h: 'Patients', v: (x) => x.patients, fmt: 'int' },
      { h: 'Items', v: (x) => x.lines, fmt: 'int' },
      { h: 'Value incl VAT', v: (x) => x.total, fmt: 'money' },
      { h: 'Medical aid share', v: (x) => x.claim, fmt: 'money' },
      { h: 'Patient share', v: (x) => x.patientShare, fmt: 'money' },
      { h: 'Per script', v: (x) => x.perScript, fmt: 'money' },
      { h: 'Cost', v: (x) => x.cost, fmt: 'money' },
      { h: 'GP', v: (x) => x.gp, fmt: 'money' },
      { h: 'GP %', v: (x) => x.gpPct, fmt: 'pct' },
    ]
    const dl = await download(c, file(`scripts-by-${by}`, range), title, cols, [...rows, totals])
    if (dl) return dl
    return page(c, title, <Report c={c} title={title} range={range} cols={cols} rows={rows} foot={totals} keep={`by=${by}`}
      intro="Dispensed scripts counted and valued. A script reversed later is left out. Patients are counted once per row."
      before={<nav class="tabs" style="margin-bottom:12px">{([['day', 'By day'], ['aid', 'By medical aid'], ['doctor', 'By doctor'], ['dispenser', 'By dispenser']] as const)
        .map(([k, l]) => <a class={k === by ? 'on' : ''} href={`?by=${k}&from=${range.from}&to=${range.to}`}>{l}</a>)}</nav>}
      filters={<input type="hidden" name="by" value={by} />}
      summary={`${totals.scripts} scripts (${totals.newScripts} new, ${totals.repeats} repeats) for ${totals.patients} patients, ${money(totals.total)} incl VAT.`}
      hint="GP is on the script value excluding VAT, at each item's cost when it was dispensed." />)
  })

  // ------------------------------------------------------------ patients

  r.get('/patients', async (c) => {
    const range = await rangeFrom(c, thisMonth)
    const aid = c.req.query('aid') ?? ''
    const all = c.req.query('all') === 'on'
    const { rows, aids } = await run(c, async (tx) => ({
      rows: await patientList(tx, range, { all, aidId: aid || undefined }),
      aids: await listMedicalAids(tx),
    }))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Patient', v: (x) => x.name },
      { h: 'ID number', v: (x) => x.idNo },
      { h: 'Date of birth', v: (x) => x.dateOfBirth, show: (x) => date(x.dateOfBirth) },
      { h: 'Age', v: (x) => ageOn(x.dateOfBirth), fmt: 'int' },
      { h: 'Sex', v: (x) => x.sex },
      { h: 'Phone', v: (x) => x.phone },
      { h: 'Medical aid', v: (x) => x.medicalAid },
      { h: 'Member no', v: (x) => x.memberNo },
      { h: 'Dep', v: (x) => x.dependantCode },
      { h: 'Usual doctor', v: (x) => x.doctor },
      { h: 'Allergies', v: (x) => x.allergies, show: (x) => x.allergies && <span class="neg">{x.allergies}</span> },
      { h: 'Scripts', v: (x) => x.scripts, fmt: 'int' },
      { h: 'Value incl VAT', v: (x) => x.value, fmt: 'money' },
      { h: 'Last visit', v: (x) => (x.lastVisit ? date(x.lastVisit) : null) },
    ]
    const dl = await download(c, file('patients', range), 'Patients', cols, rows)
    if (dl) return dl
    return page(c, 'Patients', <Report c={c} title="Patients" range={range} cols={cols} rows={rows}
      intro={all ? 'All active patients. Scripts and value are for the range.' : 'Patients who had a script dispensed in the range.'}
      keep={[aid && `aid=${aid}`, all && 'all=on'].filter(Boolean).join('&')}
      filters={<>
        <label class="f">Medical aid<select name="aid"><option value="">All</option><option value="private" selected={aid === 'private'}>Private</option>
          {aids.map((a) => <option value={a.id} selected={aid === a.id}>{a.name}</option>)}</select></label>
        <label class="row"><input type="checkbox" name="all" checked={all} /> Include patients not seen in the range</label>
      </>}
      summary={`${rows.length} patients; ${rows.reduce((a, x) => a + x.scripts, 0)} scripts for ${money(rows.reduce((a, x) => a + x.value, 0))} in the range.`}
      href={(x) => `/dispensary/patients/${x.id}`} />)
  })

  r.get('/last-visit', async (c) => {
    const range = await rangeFrom(c, (today) => ({ from: shiftDay(today, -365), to: shiftDay(today, -60) }))
    const rows = await run(c, (tx) => lastVisit(tx, range))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Last visit', v: (x) => (x.lastVisit ? date(x.lastVisit) : null) },
      { h: 'Days since', v: (x) => (x.lastVisit ? Math.floor((Date.now() - new Date(x.lastVisit).getTime()) / 86400_000) : null), fmt: 'int' },
      { h: 'Patient', v: (x) => x.name },
      { h: 'Phone', v: (x) => x.phone },
      { h: 'Medical aid', v: (x) => x.medicalAid },
      { h: 'Member no', v: (x) => x.memberNo },
      { h: 'Last script', v: (x) => x.lastScriptNo, fmt: 'int' },
      { h: 'Last items', v: (x) => x.lastItems },
      { h: 'Scripts ever', v: (x) => x.scripts, fmt: 'int' },
    ]
    const dl = await download(c, file('last-visit', range), 'Last patient visit', cols, rows)
    if (dl) return dl
    return page(c, 'Last patient visit', <Report c={c} title="Last patient visit" range={range} cols={cols} rows={rows}
      intro="Patients whose most recent script was dispensed in the range and who have not been back since, longest gone first. Set the range to find chronic patients who have stopped coming."
      summary={`${rows.length} patients last seen between ${date(range.from)} and ${date(range.to)}.`}
      href={(x) => `/dispensary/patients/${x.id}`} />)
  })

  // ------------------------------------------------------------ repeats

  r.get('/repeats', async (c) => {
    const range = await rangeFrom(c, (today) => ({ from: shiftDay(today, -90), to: today }))
    const rows = await run(c, (tx) => repeatsDue(tx, range))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Due', v: (x) => x.due, show: (x) => date(x.due) },
      { h: 'Days late', v: (x) => x.daysOverdue, fmt: 'int', show: (x) => (x.daysOverdue > 0 ? <span class="neg">{x.daysOverdue}</span> : x.daysOverdue) },
      { h: 'Patient', v: (x) => x.patient },
      { h: 'Phone', v: (x) => x.phone },
      { h: 'Medical aid', v: (x) => x.medicalAid },
      { h: 'Script', v: (x) => x.scriptNo, fmt: 'int', show: (x) => <a href={`/dispensary/scripts/${x.scriptId}`}>{x.scriptNo}</a> },
      { h: 'Item', v: (x) => x.description },
      { h: 'Quantity', v: (x) => x.qtyUnits, fmt: 'int', show: (x) => qty(x.qtyUnits, x.packSize) },
      { h: 'Directions', v: (x) => x.directions },
      { h: 'Repeats left', v: (x) => x.repeatsLeft, fmt: 'int' },
      { h: 'Last filled', v: (x) => x.lastFilled, show: (x) => date(x.lastFilled) },
      { h: 'Valid until', v: (x) => x.expires, show: (x) => date(x.expires) },
    ]
    const dl = await download(c, file('repeats-due', range), 'Repeats not collected', cols, rows)
    if (dl) return dl
    return page(c, 'Repeats not collected', <Report c={c} title="Repeats not collected" range={range} cols={cols} rows={rows}
      intro="Repeats that fell due in the range and have not been filled. Due is the last supply plus its days' supply. Repeats past their validity are left out."
      summary={`${rows.length} repeats due, ${rows.filter((x) => x.daysOverdue > 0).length} of them late.`}
      href={(x) => `/dispensary/scripts/${x.scriptId}`}
      hint="Open a line to start the repeat from the script." />)
  })

  // ------------------------------------------------------------ price changes

  r.get('/price-changes', async (c) => {
    const range = await rangeFrom(c, (today) => ({ from: shiftDay(today, -30), to: today }))
    const source = c.req.query('source') ?? ''
    const dispensed = c.req.query('dispensed') === 'on'
    const rows = await run(c, (tx) => priceChanges(tx, range, { source: source || undefined, dispensedOnly: dispensed }))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'When', v: (x) => dateTime(x.at) },
      { h: 'Code', v: (x) => x.stockCode },
      { h: 'Description', v: (x) => x.description },
      { h: 'Old cost', v: (x) => x.oldCost, fmt: 'money' },
      { h: 'New cost', v: (x) => x.newCost, fmt: 'money' },
      { h: 'Old price', v: (x) => x.oldRetail, fmt: 'money' },
      { h: 'New price', v: (x) => x.newRetail, fmt: 'money' },
      { h: 'Price change %', v: (x) => x.changePct, fmt: 'pct', show: (x) => x.changePct === null ? '' : <span class={x.changePct > 0 ? 'neg' : x.changePct < 0 ? 'pos' : ''}>{x.changePct > 0 ? '+' : ''}{x.changePct}%</span> },
      { h: 'Why', v: (x) => priceSources[x.source] ?? x.source },
      { h: 'By', v: (x) => x.by },
    ]
    const dl = await download(c, file('price-changes', range), 'Price changes', cols, rows)
    if (dl) return dl
    return page(c, 'Price changes', <Report c={c} title="Price changes" range={range} cols={cols} rows={rows}
      intro="Every change to an item's cost (per pack, excl VAT) or selling price (per pack, incl VAT), newest first."
      keep={[source && `source=${source}`, dispensed && 'dispensed=on'].filter(Boolean).join('&')}
      filters={<>
        <label class="f">Why<select name="source"><option value="">Any</option>
          {Object.entries(priceSources).filter(([k]) => k !== 'import').map(([k, l]) => <option value={k} selected={source === k}>{l}</option>)}</select></label>
        <label class="row"><input type="checkbox" name="dispensed" checked={dispensed} /> Only items that have been dispensed</label>
      </>}
      href={(x) => `/items/${x.itemId}`} />)
  })

  // ------------------------------------------------------------ reversed scripts

  r.get('/reversed', async (c) => {
    const range = await rangeFrom(c, thisMonth)
    const rows = await run(c, (tx) => reversedScripts(tx, range))
    type R = (typeof rows)[number]
    const cols: ScreenCol<R>[] = [
      { h: 'Reversed', v: (x) => dateTime(x.reversedAt) },
      { h: 'Script', v: (x) => x.scriptNo, fmt: 'int' },
      { h: 'Dispensed', v: (x) => dateTime(x.dispensedAt) },
      { h: 'Patient', v: (x) => x.patient },
      { h: 'Items', v: (x) => x.items },
      { h: 'Value', v: (x) => x.total, fmt: 'money' },
      { h: 'Reason', v: (x) => x.reason },
      { h: 'Dispensed by', v: (x) => x.dispensedBy },
      { h: 'Reversed by', v: (x) => x.reversedBy },
    ]
    const dl = await download(c, file('reversed-scripts', range), 'Reversed scripts', cols, rows)
    if (dl) return dl
    return page(c, 'Reversed scripts', <Report c={c} title="Reversed scripts" range={range} cols={cols} rows={rows}
      intro="Scripts reversed in the range. The stock came back and the script stays on record, marked reversed."
      href={(x) => `/dispensary/scripts/${x.id}`} />)
  })

  return r
}
