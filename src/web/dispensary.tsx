import { Hono } from 'hono'
import { raw } from 'hono/html'
import { listAccounts } from '../domain/accounts.js'
import { DomainError } from '../domain/errors.js'
import { findByCode, searchItems } from '../domain/items.js'
import {
  addFlag, ageOn, createPatient, familyOf, getDoctor, getPatient, listDirections, listDoctors, listMedicalAids, patientFlags, removeFlag,
  saveDirection, saveDoctor, saveMedicalAid, searchPatients, updatePatient, type Patient, type PatientInput,
} from '../domain/patients.js'
import { bounds } from '../domain/sales.js'
import {
  addLine, cancelOwed, createDraft, discardDraft, dispenseScript, draftScripts, getScript, initials, labelsFor, listOwed, patientScripts,
  register, removeLine, reverseScript, scriptBook, scriptIdByNo, scriptWarnings, setSupply, startRepeat, supplyOwed, updateDraft, type Label,
} from '../domain/scripts.js'
import { getSettings, getShop, nextScriptNo, setNextScriptNo, updateSettings, updateShop } from '../domain/settings.js'
import { back, page, requireRole, run, type Ctx, type Env } from './app.js'
import { RangeForm, rangeFrom } from './cashup.js'
import { date, dateTime, money } from './layout.js'
import { csv } from './reports.js'

/**
 * The dispensary: find or add a patient, capture a script, check it, dispense it, print labels.
 * Assistants may capture scripts; a pharmacist or the owner dispenses, reverses and hands over
 * owed items.
 */

const str = (v: unknown) => String(v ?? '').trim()
const intOrNull = (v: unknown) => (str(v) === '' ? null : Number(str(v)))
const pharmacist = (c: Ctx) => ['owner', 'pharmacist'].includes(c.get('user').role)

// Suggests items as the name is typed; the field still accepts a scanned barcode or a stock code.
const itemPicker = `
document.querySelectorAll('input[data-items]').forEach((inp) => {
  const dl = document.getElementById(inp.getAttribute('list')); let timer
  inp.addEventListener('input', () => {
    clearTimeout(timer); const q = inp.value.trim(); if (q.length < 2) return
    timer = setTimeout(async () => {
      const res = await fetch('/api/items?q=' + encodeURIComponent(q)); if (!res.ok) return
      dl.replaceChildren(...(await res.json()).map((i) => {
        const o = document.createElement('option'); o.value = i.stockCode
        o.label = i.description + ' · ' + i.onHandUnits + ' units on hand' + (i.schedule !== null ? ' · S' + i.schedule : ''); return o
      }))
    }, 200)
  })
})`

function PatientPanel({ p, flags }: { p: Patient; flags?: { kind: string; text: string; detail: string | null }[] }) {
  const age = ageOn(p.dateOfBirth)
  const allergies = (flags ?? []).filter((f) => f.kind === 'allergy')
  const alerts = (flags ?? []).filter((f) => f.kind === 'alert')
  return (
    <div class="panel">
      <div class="row">
        <b style="font-size:16px"><a href={`/dispensary/patients/${p.id}`}>{p.name}</a></b>
        {age !== null && <span class="chip">{age} yrs</span>}
        {p.sex && <span class="chip">{p.sex}</span>}
        {p.idNo && <span class="muted">ID {p.idNo}</span>}
        {p.phone && <span class="muted">{p.phone}</span>}
        <span class="spacer" />
        {p.medicalAidName
          ? <span>{p.medicalAidName} <b>{p.memberNo}</b>{p.dependantCode && <span class="muted"> / {p.dependantCode}</span>}{p.mainMemberName && <span class="muted"> · dependant of {p.mainMemberName}</span>}</span>
          : <span class="muted">Private patient</span>}
      </div>
      {allergies.length > 0 && <div class="msg err" style="margin:8px 0 0">Allergies: {allergies.map((a) => <b>{a.text}{a.detail ? ` (${a.detail})` : ''} </b>)}</div>}
      {alerts.map((a) => <div class="msg warn" style="margin:8px 0 0">{a.text}</div>)}
      {p.medicalAidMessage && <div class="hint" style="margin-top:6px">{p.medicalAidName}: {p.medicalAidMessage}</div>}
    </div>
  )
}

function readPatient(b: Record<string, unknown>): PatientInput {
  return {
    surname: str(b.surname), firstNames: str(b.firstNames), title: str(b.title), idNo: str(b.idNo), dateOfBirth: str(b.dateOfBirth),
    sex: str(b.sex), phone: str(b.phone), address: str(b.address), mainMemberId: str(b.mainMemberId) || null,
    medicalAidId: str(b.medicalAidId) || null, memberNo: str(b.memberNo), dependantCode: str(b.dependantCode) || null,
    doctorId: str(b.doctorId) || null, accountId: str(b.accountId) || null, notes: str(b.notes), active: b.inactive !== 'on',
  }
}

function PatientForm(props: { action: string; p?: Patient | null; mainMember?: Patient | null; aids: { id: string; name: string }[];
  doctors: { id: string; name: string }[]; accounts: { id: string; name: string; accountNo: string }[]; submit: string }) {
  const p = props.p
  const dependant = !!(props.mainMember ?? p?.mainMemberId)
  return (
    <form method="post" action={props.action} class="grid panel">
      {props.mainMember && <input type="hidden" name="mainMemberId" value={props.mainMember.id} />}
      {p?.mainMemberId && <input type="hidden" name="mainMemberId" value={p.mainMemberId} />}
      <label>Surname<input name="surname" required value={p?.surname ?? props.mainMember?.surname ?? ''} autofocus /></label>
      <label>First names<input name="firstNames" value={p?.firstNames ?? ''} /></label>
      <label>Title<select name="title">{['', 'Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Master'].map((t) => <option selected={(p?.title ?? '') === t}>{t}</option>)}</select></label>
      <label>ID or passport number<input name="idNo" value={p?.idNo ?? ''} /></label>
      <label>Date of birth<input name="dateOfBirth" type="date" value={p?.dateOfBirth ?? ''} /></label>
      <label>Sex<select name="sex"><option value=""></option>{['F', 'M', 'X'].map((s) => <option selected={p?.sex === s}>{s}</option>)}</select></label>
      <label>Phone<input name="phone" value={p?.phone ?? ''} /></label>
      <label>Address<input name="address" value={p?.address ?? ''} /></label>
      {dependant
        ? <label>Dependant code<input name="dependantCode" value={p?.dependantCode ?? ''} placeholder="next free number" /></label>
        : <>
            <label>Medical aid<select name="medicalAidId"><option value="">None (private)</option>{props.aids.map((a) => <option value={a.id} selected={p?.medicalAidId === a.id}>{a.name}</option>)}</select></label>
            <label>Member number<input name="memberNo" value={p?.memberNo ?? ''} /></label>
          </>}
      <label>Usual doctor<select name="doctorId"><option value=""></option>{props.doctors.map((d) => <option value={d.id} selected={p?.doctorId === d.id}>{d.name}</option>)}</select></label>
      <label>Customer account<select name="accountId"><option value="">None</option>{props.accounts.map((a) => <option value={a.id} selected={p?.accountId === a.id}>{a.name} ({a.accountNo})</option>)}</select></label>
      <label>Notes<input name="notes" value={p?.notes ?? ''} /></label>
      {p && <label class="row" style="flex-direction:row"><input type="checkbox" name="inactive" checked={!p.active} /> Inactive (moved away, died)</label>}
      <div><button>{props.submit}</button></div>
    </form>
  )
}

const statusChip = (s: string) => <span class={s === 'dispensed' ? 'st-active' : s === 'reversed' ? 'st-quarantined' : 'st-dormant'}>{s}</span>

export function dispensaryRoutes() {
  const r = new Hono<Env>()

  // ------------------------------------------------------------ home: find a patient

  r.get('/', async (c) => {
    const q = c.req.query('q') ?? ''
    const { patients, drafts, owed, next } = await run(c, async (tx) => ({
      patients: await searchPatients(tx, q, { limit: 50 }),
      drafts: await draftScripts(tx),
      owed: await listOwed(tx),
      next: await nextScriptNo(tx),
    }))
    return page(c, 'Dispensary', (
      <>
        <div class="row"><h1>Dispensary</h1><span class="spacer" />
          <a class="btn secondary" href="/dispensary/scripts">Script book</a>
          <a class="btn secondary" href="/dispensary/owed">Owed items ({owed.length})</a>
          <a class="btn secondary" href="/dispensary/register">Register</a>
          <a class="btn secondary" href="/dispensary/doctors">Doctors</a>
          <a class="btn secondary" href="/dispensary/settings">Dispensing settings</a>
        </div>
        <form class="row panel">
          <input name="q" data-search value={q} placeholder="Patient surname (and first name), ID, member number or phone  ( / )" style="flex:1" autofocus />
          <button>Find</button>
          <a class="btn secondary" href={`/dispensary/patients/new${q && !/\d/.test(q) ? `?surname=${encodeURIComponent(q)}` : ''}`}>New patient</a>
        </form>
        <form class="row" action="/dispensary/scripts" style="margin-bottom:12px">
          <input name="no" inputmode="numeric" placeholder="Script number" style="width:160px" />
          <button class="secondary">Open script</button>
          <span class="hint">The next script dispensed will be number {next}.</span>
        </form>
        {q && (
          <div class="wrap"><table>
            <thead><tr><th>Patient</th><th>ID</th><th>Born</th><th>Medical aid</th><th>Member</th><th>Phone</th></tr></thead>
            <tbody>{patients.map((p) => (
              <tr data-href={`/dispensary/patients/${p.id}`}>
                <td><a href={`/dispensary/patients/${p.id}`}>{p.name}</a>{p.mainMemberName && <span class="muted"> · dep. of {p.mainMemberName}</span>}</td>
                <td>{p.idNo}</td><td>{p.dateOfBirth ? date(p.dateOfBirth) : ''}</td><td>{p.medicalAidName ?? <span class="muted">private</span>}</td>
                <td>{p.memberNo}{p.dependantCode ? ` / ${p.dependantCode}` : ''}</td><td>{p.phone}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        {q && !patients.length && <p class="muted">No patient matches "{q}". Check the spelling, or add them as a new patient.</p>}
        <h2>Unfinished scripts</h2>
        {drafts.length
          ? <div class="wrap"><table>
              <thead><tr><th>Started</th><th>Patient</th><th class="n">Lines</th><th>By</th></tr></thead>
              <tbody>{drafts.map((d) => (
                <tr data-href={`/dispensary/scripts/${d.id}`}><td>{dateTime(d.createdAt)}</td>
                  <td><a href={`/dispensary/scripts/${d.id}`}>{d.patientName}</a>{d.repeat && <span class="chip">repeat</span>}</td>
                  <td class="n">{d.lines}</td><td>{d.by}</td></tr>
              ))}</tbody>
            </table></div>
          : <p class="muted">None. Scripts stay here until they are dispensed or discarded.</p>}
      </>
    ))
  })

  // ------------------------------------------------------------ patients

  r.get('/patients/new', async (c) => {
    const mainId = c.req.query('main')
    const data = await run(c, async (tx) => ({
      main: mainId ? await getPatient(tx, mainId) : null,
      aids: await listMedicalAids(tx, { activeOnly: true }), doctors: await listDoctors(tx, '', { activeOnly: true }),
      accounts: await listAccounts(tx, { activeOnly: true }),
    }))
    const seed = c.req.query('surname') ? ({ surname: c.req.query('surname')!.toUpperCase() } as Patient) : null
    return page(c, 'New patient', (
      <>
        <h1>{data.main ? `New dependant of ${data.main.name}` : 'New patient'}</h1>
        {data.main && <p class="muted">Dependants use {data.main.name}'s medical aid ({data.main.medicalAidName ?? 'none'} {data.main.memberNo ?? ''}).</p>}
        <PatientForm action="/dispensary/patients" p={seed} mainMember={data.main} aids={data.aids} doctors={data.doctors} accounts={data.accounts} submit="Add patient" />
        {!data.aids.length && <p class="hint">No medical aids are set up yet. Add them under <a href="/dispensary/settings">Dispensing settings</a>.</p>}
      </>
    ))
  })

  r.post('/patients', async (c) => {
    const b = await c.req.parseBody()
    const id = await run(c, (tx) => createPatient(tx, readPatient(b), c.get('user').userId))
    return c.redirect(`/dispensary/patients/${id}`)
  })

  r.get('/patients/:id', async (c) => {
    const id = c.req.param('id')
    const data = await run(c, async (tx) => {
      const p = await getPatient(tx, id)
      if (!p) throw new DomainError('unknown patient', 'not_found', 404)
      const settings = await getSettings(tx)
      return {
        p, settings, flags: await patientFlags(tx, id), family: await familyOf(tx, p), scripts: await patientScripts(tx, id),
        owed: await listOwed(tx, { patientId: id }), aids: await listMedicalAids(tx), doctors: await listDoctors(tx, '', { activeOnly: true }),
        accounts: await listAccounts(tx, { activeOnly: true }),
      }
    })
    const { p } = data
    const today = new Date().toISOString().slice(0, 10)
    return page(c, p.name, (
      <>
        <h1>{p.name}{!p.active && <span class="st-dormant"> (inactive)</span>}</h1>
        <PatientPanel p={p} flags={data.flags} />
        <h2>New script</h2>
        <form method="post" action={`/dispensary/patients/${p.id}/scripts`} class="grid panel">
          <label>Doctor<select name="doctorId"><option value="">None on the script</option>{data.doctors.map((d) => <option value={d.id} selected={d.id === p.doctorId}>{d.name}{d.practiceNo ? ` (${d.practiceNo})` : ''}</option>)}</select></label>
          <label>Date on the script<input name="rxDate" type="date" value={today} max={today} required /></label>
          {p.medicalAidName && <label class="row" style="flex-direction:row"><input type="checkbox" name="private" /> Patient pays (don't bill {p.medicalAidName})</label>}
          <div><button>Start script</button></div>
        </form>
        <LabelLink id={c.req.query('label')} />
        {data.owed.length > 0 && <>
          <h2>Owed to this patient</h2>
          <OwedTable owed={data.owed} canSupply={pharmacist(c)} />
        </>}
        <h2>Scripts</h2>
        {data.scripts.length
          ? <div class="wrap"><table>
              <thead><tr><th>Script</th><th>Date</th><th>Doctor</th><th>Items</th><th class="n">Total</th><th>Status</th><th class="n">Repeats left</th></tr></thead>
              <tbody>{data.scripts.map((s) => (
                <tr data-href={`/dispensary/scripts/${s.id}`}><td><a href={`/dispensary/scripts/${s.id}`}>{s.scriptNo ?? 'draft'}</a>{s.repeat && <span class="chip">repeat</span>}</td>
                  <td>{date(s.at)}</td><td>{s.doctorName}</td><td>{s.items}</td><td class="n">{money(s.total)}</td><td>{statusChip(s.status)}</td>
                  <td class="n">{s.repeatsLeft || ''}</td></tr>
              ))}</tbody>
            </table></div>
          : <p class="muted">No scripts yet.</p>}
        <h2>Allergies and alerts</h2>
        <div class="wrap"><table>
          <tbody>{data.flags.map((f) => (
            <tr><td>{f.kind === 'allergy' ? <b class="neg">Allergy</b> : <b>Alert</b>}</td><td>{f.text}{f.detail && <span class="muted"> · {f.detail}</span>}</td>
              <td class="muted">{f.createdBy} {date(f.createdAt)}</td>
              <td class="n"><form method="post" action={`/dispensary/flags/${f.id}/remove`}><button class="secondary">Remove</button></form></td></tr>
          ))}</tbody>
        </table></div>
        <form method="post" action={`/dispensary/patients/${p.id}/flags`} class="grid panel">
          <label>Kind<select name="kind"><option value="allergy">Allergy</option><option value="alert">Alert (shown on every script)</option></select></label>
          <label>Allergic to, or the alert<input name="text" required placeholder="e.g. PENICILLIN" /></label>
          <label>Reaction or detail<input name="detail" placeholder="e.g. rash" /></label>
          <div><button>Add</button></div>
        </form>
        <p class="hint">sylken has no ingredient data, so it only spots an allergy written the way an item is named. Every script for a patient with allergies asks the pharmacist to check them.</p>
        <h2>Family</h2>
        <div class="wrap"><table>
          <thead><tr><th>Code</th><th>Name</th><th>Born</th><th>ID</th></tr></thead>
          <tbody>{data.family.map((f) => (
            <tr data-href={`/dispensary/patients/${f.id}`} class={f.id === p.id ? 'sel' : ''}><td>{f.dependantCode}</td><td><a href={`/dispensary/patients/${f.id}`}>{f.name}</a></td>
              <td>{f.dateOfBirth ? date(f.dateOfBirth) : ''}</td><td>{f.idNo}</td></tr>
          ))}</tbody>
        </table></div>
        <p><a class="btn secondary" href={`/dispensary/patients/new?main=${p.mainMemberId ?? p.id}`}>Add a dependant</a></p>
        <details><summary><b>Edit details</b></summary>
          <PatientForm action={`/dispensary/patients/${p.id}`} p={p} aids={data.aids} doctors={data.doctors} accounts={data.accounts} submit="Save" />
        </details>
      </>
    ))
  })

  r.post('/patients/:id', async (c) => {
    const b = await c.req.parseBody()
    await run(c, (tx) => updatePatient(tx, c.req.param('id'), readPatient(b), c.get('user').userId))
    return back(c, `/dispensary/patients/${c.req.param('id')}`, { ok: 'Saved' })
  })

  r.post('/patients/:id/flags', async (c) => {
    const b = await c.req.parseBody()
    const kind = b.kind === 'alert' ? 'alert' : 'allergy'
    await run(c, (tx) => addFlag(tx, c.req.param('id'), { kind, text: str(b.text), detail: str(b.detail) }, c.get('user').userId))
    return back(c, `/dispensary/patients/${c.req.param('id')}`, { ok: kind === 'allergy' ? 'Allergy added' : 'Alert added' })
  })

  r.post('/flags/:id/remove', async (c) => {
    requireRole(c, ['owner', 'pharmacist'])
    const pid = await run(c, (tx) => removeFlag(tx, c.req.param('id'), c.get('user').userId))
    return back(c, `/dispensary/patients/${pid}`, { ok: 'Removed' })
  })

  r.post('/patients/:id/scripts', async (c) => {
    const b = await c.req.parseBody()
    const id = await run(c, (tx) => createDraft(tx, {
      patientId: c.req.param('id'), doctorId: str(b.doctorId) || null, rxDate: str(b.rxDate), billMedicalAid: b.private !== 'on',
    }, c.get('user').userId))
    return c.redirect(`/dispensary/scripts/${id}`)
  })

  // ------------------------------------------------------------ scripts

  r.get('/scripts', async (c) => {
    const no = c.req.query('no')
    if (no) {
      const id = await run(c, (tx) => scriptIdByNo(tx, Number(no)))
      if (!id) return back(c, '/dispensary', { err: `There is no script number ${no}` })
      return c.redirect(`/dispensary/scripts/${id}`)
    }
    const range = await rangeFrom(c)
    const rows = await run(c, async (tx) => scriptBook(tx, await bounds(tx, range)))
    if (c.req.query('format') === 'csv') {
      c.header('content-type', 'text/csv')
      c.header('content-disposition', `attachment; filename="script-book-${range.from}-${range.to}.csv"`)
      return c.body(csv([
        ['Script', 'Dispensed', 'Script date', 'Status', 'Patient', 'ID', 'Doctor', 'Medical aid', 'Member', 'Items', 'Total', 'Claim', 'Patient pays', 'Paid at till', 'Dispensed by'],
        ...rows.map((s) => [s.scriptNo, dateTime(s.dispensedAt), s.rxDate, s.status + (s.repeat ? ' (repeat)' : ''), s.patientName, s.idNo, s.doctorName,
          s.medicalAid, s.memberNo, s.items, s.total.toFixed(2), s.claimTotal.toFixed(2), s.patientTotal.toFixed(2), s.paid.toFixed(2), s.dispensedBy]),
      ]))
    }
    const live = rows.filter((s) => s.status === 'dispensed')
    const sum = (f: (s: (typeof rows)[number]) => number) => live.reduce((a, s) => a + f(s), 0)
    return page(c, 'Script book', (
      <>
        <div class="row"><h1>Script book</h1><span class="spacer" /><a class="btn secondary" href={`?from=${range.from}&to=${range.to}&format=csv`}>Download CSV</a></div>
        <RangeForm {...range} />
        <p class="muted">{live.length} scripts dispensed{rows.length > live.length ? `, ${rows.length - live.length} reversed` : ''}: {money(sum((s) => s.total))} in total,
          {' '}{money(sum((s) => s.claimTotal))} to claim from medical aids, {money(sum((s) => s.patientTotal))} for patients to pay.</p>
        <div class="wrap"><table>
          <thead><tr><th>Script</th><th>Dispensed</th><th>Patient</th><th>Doctor</th><th>Medical aid</th><th>Items</th><th class="n">Total</th><th class="n">Claim</th><th class="n">Patient</th><th class="n">Paid</th><th>By</th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr data-href={`/dispensary/scripts/${s.id}`} class={s.status === 'reversed' ? 'muted' : ''}>
              <td><a href={`/dispensary/scripts/${s.id}`}>{s.scriptNo}</a>{s.repeat && <span class="chip">repeat</span>}{s.status === 'reversed' && <span class="chip">reversed</span>}</td>
              <td>{dateTime(s.dispensedAt)}</td><td>{s.patientName}</td><td>{s.doctorName}</td><td>{s.medicalAid}{s.memberNo ? ` ${s.memberNo}` : ''}</td>
              <td>{s.items}</td><td class="n">{money(s.total)}</td><td class="n">{money(s.claimTotal)}</td><td class="n">{money(s.patientTotal)}</td>
              <td class={`n ${s.status === 'dispensed' && s.paid < s.patientTotal + s.claimTotal ? 'neg' : ''}`}>{money(s.paid)}</td><td>{s.dispensedBy}</td></tr>
          ))}</tbody>
        </table></div>
        <p class="hint">"Paid" is what was taken at the till for the script, medical aid share included. Red means it has not been rung up in full yet.</p>
      </>
    ))
  })

  r.get('/scripts/:id', async (c) => {
    const id = c.req.param('id')
    const data = await run(c, async (tx) => {
      const s = await getScript(tx, id)
      if (!s) throw new DomainError('unknown script', 'not_found', 404)
      const settings = await getSettings(tx)
      const flags = await patientFlags(tx, s.patient.id)
      return { s, settings, flags, warnings: s.status === 'draft' ? scriptWarnings(s, flags, settings) : [],
        doctors: await listDoctors(tx, '', { activeOnly: true }), directions: await listDirections(tx) }
    })
    const { s, warnings, settings } = data
    const draft = s.status === 'draft'
    const canDispense = pharmacist(c)
    const needsConfirm = warnings.some((w) => w.level === 'confirm')
    const needsStock = warnings.some((w) => w.level === 'stock')
    const blocked = warnings.some((w) => w.level === 'block')
    const title = draft ? (s.repeatOf ? `Repeat of script ${s.repeatOf.scriptNo}` : 'New script') : `Script ${s.scriptNo}`
    return page(c, title, (
      <>
        <div class="row">
          <h1>{title} {statusChip(s.status)}</h1><span class="spacer" />
          {s.status === 'dispensed' && <a class="btn" href={`/dispensary/scripts/${s.id}/labels`} target="_blank">Print labels</a>}
          {s.status === 'dispensed' && !s.repeatOf && s.lines.some((l) => (l.repeatsLeft ?? 0) > 0) &&
            <form method="post" action={`/dispensary/scripts/${s.id}/repeat`}><button class="secondary">Give a repeat</button></form>}
          {s.repeatOf && <a class="btn secondary" href={`/dispensary/scripts/${s.repeatOf.id}`}>Original script {s.repeatOf.scriptNo}</a>}
        </div>
        <PatientPanel p={s.patient} flags={data.flags} />
        <div class="panel row">
          {draft && !s.repeatOf
            ? <form method="post" action={`/dispensary/scripts/${s.id}`} class="row" style="flex:1">
                <label class="f">Doctor<select name="doctorId"><option value="">None on the script</option>{data.doctors.map((d) => <option value={d.id} selected={d.id === s.doctorId}>{d.name}{d.practiceNo ? ` (${d.practiceNo})` : ''}</option>)}</select></label>
                <label class="f">Date on the script<input name="rxDate" type="date" value={s.rxDate} required /></label>
                {s.patient.medicalAidName && <label class="row" style="flex-direction:row"><input type="checkbox" name="private" checked={!s.billMedicalAid} /> Patient pays</label>}
                <button class="secondary">Save</button>
              </form>
            : <span>{s.doctorName ? <>Dr: <b>{s.doctorName}</b>{s.doctorPracticeNo && <span class="muted"> ({s.doctorPracticeNo})</span>}</> : <span class="muted">No doctor</span>} · Script date {date(s.rxDate)}
                {s.repeatNo ? <> · Repeat {s.repeatNo}</> : ''}</span>}
          <span class="spacer" />
          <span>{s.medicalAidName ? <>Bill <b>{s.medicalAidName}</b> {s.memberNo}{s.dependantCode ? `/${s.dependantCode}` : ''}</> : <span class="muted">Patient pays all</span>}</span>
        </div>
        {!draft && <p class="muted">Dispensed {dateTime(s.dispensedAt)} by {s.dispensedBy ?? 'unknown'}. Captured by {s.createdBy ?? 'unknown'}.
          {s.status === 'reversed' && <b class="neg"> Reversed {dateTime(s.reversedAt)} by {s.reversedBy}: {s.reverseReason}</b>}</p>}

        <div class="wrap"><table>
          <thead><tr><th>#</th><th>Item</th><th class="n">Qty</th><th class="n">Given</th><th>Directions</th><th class="n">Days</th><th class="n">Repeats</th><th>ICD-10</th><th class="n">Item</th><th class="n">Fee</th><th class="n">Total</th>{draft && <th />}</tr></thead>
          <tbody>{s.lines.map((l) => (
            <tr>
              <td>{l.lineNo}</td>
              <td><a href={`/items/${l.itemId}`}>{l.description}</a> <span class="muted">{l.stockCode}</span>
                {l.schedule !== null && <span class="chip">S{l.schedule}</span>}{l.noClaim && <span class="chip">no claim</span>}
                {draft && <div class="hint">{l.onHandUnits} units on hand{l.packSize > 1 ? `, pack of ${l.packSize}` : ''}</div>}</td>
              <td class="n">{l.qtyUnits}</td>
              <td class="n">{draft && s.repeatOf
                ? <form method="post" action={`/dispensary/scripts/${s.id}/lines/${l.id}/supply`} class="row" style="justify-content:flex-end">
                    <input name="supply" type="number" min="0" max={l.qtyUnits} value={l.supplyUnits} style="width:70px" /><button class="secondary">Set</button></form>
                : l.supplyUnits}
                {l.owedUnits > 0 && <div class="neg">{l.owedUnits} owed</div>}</td>
              <td>{l.directions}</td><td class="n">{l.supplyDays}</td>
              <td class="n">{s.repeatOf ? '' : l.repeats ? `${l.repeatsLeft ?? l.repeats} of ${l.repeats} left` : ''}</td>
              <td>{l.icd10.join(', ')}</td>
              <td class="n">{money(l.itemTotal)}</td><td class="n">{money(l.fee)}</td><td class="n">{money(l.lineTotal)}</td>
              {draft && <td>{!s.repeatOf && <form method="post" action={`/dispensary/scripts/${s.id}/lines/${l.id}/delete`}><button class="secondary" title="Remove line">✕</button></form>}</td>}
            </tr>
          ))}</tbody>
          <tfoot><tr><td colspan={8} /><td colspan={2}><b>Total incl VAT</b></td><td class="n"><b>{money(s.total)}</b></td>{draft && <td />}</tr>
            <tr><td colspan={8} /><td colspan={2}>Medical aid</td><td class="n">{money(s.claimTotal)}</td>{draft && <td />}</tr>
            <tr><td colspan={8} /><td colspan={2}>Patient pays</td><td class="n">{money(s.patientTotal)}</td>{draft && <td />}</tr></tfoot>
        </table></div>

        {draft && !s.repeatOf && <>
          <h2>Add an item</h2>
          <form method="post" action={`/dispensary/scripts/${s.id}/lines`} class="grid panel">
            <label style="grid-column:span 2">Item (scan, code or name)<input name="item" list="items-dl" data-items required autofocus autocomplete="off" /></label>
            <datalist id="items-dl" />
            <label>Quantity<span class="row"><input name="qty" type="number" min="1" step="1" required style="width:90px" />
              <select name="per"><option value="units">units</option><option value="packs">packs</option></select></span></label>
            <label>Give now (blank = all)<input name="supply" type="number" min="0" step="1" /></label>
            <label style="grid-column:span 2">Directions (code or text)<input name="directions" list="dir-dl" required autocomplete="off" placeholder="e.g. 1T3D" /></label>
            <datalist id="dir-dl">{data.directions.map((d) => <option value={d.code}>{d.text}</option>)}</datalist>
            <label>Supply days<input name="supplyDays" type="number" min="1" value={settings.defaultSupplyDays} /></label>
            <label>Repeats<input name="repeats" type="number" min="0" max="12" value="0" /></label>
            <label>ICD-10<input name="icd10" placeholder="e.g. J06.9" /></label>
            <label class="row" style="flex-direction:row"><input type="checkbox" name="noClaim" /> Patient pays for this line</label>
            <div><button>Add line</button></div>
          </form>
          <p class="hint">Price = the item at the shop's price for the units prescribed{settings.dispensingFee ? `, plus a dispensing fee of ${money(settings.dispensingFee)} a line` : ''}. Medical aid pricing rules come with claims.</p>
        </>}

        {draft && <>
          <h2>Check and dispense</h2>
          {warnings.length > 0 && <div class="panel">{warnings.map((w) => (
            <div class={w.level === 'block' ? 'neg' : w.level === 'info' ? 'muted' : ''} style="margin:2px 0">
              {w.level === 'block' ? '⛔ ' : w.level === 'info' ? 'ℹ ' : '⚠ '}{w.lineNo ? `Line ${w.lineNo}: ` : ''}{w.text}</div>
          ))}</div>}
          {canDispense
            ? <form method="post" action={`/dispensary/scripts/${s.id}/dispense`} class="panel row">
                {needsConfirm && <label class="row" style="flex-direction:row"><input type="checkbox" name="confirmed" required /> I have checked the allergies and alerts above</label>}
                {needsStock && <label class="row" style="flex-direction:row"><input type="checkbox" name="allowNegative" /> Stock count is wrong: dispense anyway</label>}
                <span class="spacer" />
                <button disabled={blocked}>Dispense and number the script</button>
              </form>
            : <p class="muted">A pharmacist dispenses this script. It stays under unfinished scripts until then.</p>}
          <form method="post" action={`/dispensary/scripts/${s.id}/discard`} class="row"><span class="spacer" /><button class="danger">Discard this {s.repeatOf ? 'repeat' : 'script'}</button></form>
        </>}

        {!draft && <>
          <h2>Payment at the till</h2>
          {s.sales.length
            ? <ul>{s.sales.map((x) => <li><a href={`/sales/${x.id}`}>{x.kind === 'refund' ? 'Refund' : 'Sale'} {x.saleNo}</a> {dateTime(x.occurredAt)} {money(x.total)}</li>)}</ul>
            : s.status === 'dispensed' && <p class="muted">Not rung up yet. At the till, press F2 and enter script number <b>{s.scriptNo}</b>.</p>}
          {s.repeats.length > 0 && <>
            <h2>Repeats</h2>
            <ul>{s.repeats.map((x) => <li><a href={`/dispensary/scripts/${x.id}`}>{x.scriptNo ? `Script ${x.scriptNo}` : 'Draft repeat'}</a> {x.status} {dateTime(x.dispensedAt)}</li>)}</ul>
          </>}
          {s.status === 'dispensed' && canDispense && (
            <details><summary>Reverse this script</summary>
              <form method="post" action={`/dispensary/scripts/${s.id}/reverse`} class="grid panel">
                <label>Why<input name="reason" required placeholder="e.g. wrong strength captured" /></label>
                <div><button class="danger">Reverse script {s.scriptNo}</button></div>
              </form>
              <p class="hint">Stock handed over comes back on the shelf and anything owed is cancelled. A script paid at the till must be refunded there first.</p>
            </details>
          )}
        </>}
        <script>{raw(itemPicker)}</script>
      </>
    ))
  })

  r.post('/scripts/:id', async (c) => {
    const b = await c.req.parseBody()
    await run(c, (tx) => updateDraft(tx, c.req.param('id'), { doctorId: str(b.doctorId) || null, rxDate: str(b.rxDate), billMedicalAid: b.private !== 'on' }))
    return back(c, `/dispensary/scripts/${c.req.param('id')}`, { ok: 'Saved' })
  })

  r.post('/scripts/:id/lines', async (c) => {
    const b = await c.req.parseBody()
    const id = c.req.param('id')
    await run(c, async (tx) => {
      const typed = str(b.item)
      let item = await findByCode(tx, typed)
      if (!item) {
        const found = await searchItems(tx, typed, { limit: 6 })
        if (!found.length) throw new DomainError(`No item matches "${typed}".`)
        if (found.length > 1) throw new DomainError(`"${typed}" matches ${found.length > 5 ? 'several items' : `${found.length} items`}: ${found.slice(0, 5).map((i) => `${i.stockCode} ${i.description}`).join('; ')}. Pick one from the list or type its code.`)
        item = found[0]
      }
      const qty = Number(str(b.qty))
      const units = b.per === 'packs' ? Math.round(qty * item.packSize) : qty
      const supply = intOrNull(b.supply)
      await addLine(tx, id, {
        itemId: item.id, qtyUnits: units, supplyUnits: supply === null ? null : b.per === 'packs' ? Math.round(supply * item.packSize) : supply,
        directions: str(b.directions), supplyDays: intOrNull(b.supplyDays), repeats: intOrNull(b.repeats) ?? 0, icd10: str(b.icd10),
        noClaim: b.noClaim === 'on',
      })
    })
    return c.redirect(`/dispensary/scripts/${id}`)
  })

  r.post('/scripts/:id/lines/:line/delete', async (c) => {
    await run(c, (tx) => removeLine(tx, c.req.param('id'), c.req.param('line')))
    return c.redirect(`/dispensary/scripts/${c.req.param('id')}`)
  })

  r.post('/scripts/:id/lines/:line/supply', async (c) => {
    const b = await c.req.parseBody()
    await run(c, (tx) => setSupply(tx, c.req.param('id'), c.req.param('line'), Number(str(b.supply))))
    return c.redirect(`/dispensary/scripts/${c.req.param('id')}`)
  })

  r.post('/scripts/:id/dispense', async (c) => {
    requireRole(c, ['owner', 'pharmacist'])
    const b = await c.req.parseBody()
    const id = c.req.param('id')
    const { scriptNo } = await run(c, (tx) => dispenseScript(tx, id, { confirmed: b.confirmed === 'on', allowNegative: b.allowNegative === 'on' }, c.get('user').userId))
    return back(c, `/dispensary/scripts/${id}`, { ok: `Dispensed as script ${scriptNo}. Print the labels, then ring it up at the till.` })
  })

  r.post('/scripts/:id/discard', async (c) => {
    const pid = await run(c, (tx) => discardDraft(tx, c.req.param('id'), c.get('user').userId))
    return back(c, `/dispensary/patients/${pid}`, { ok: 'Script discarded' })
  })

  r.post('/scripts/:id/reverse', async (c) => {
    requireRole(c, ['owner', 'pharmacist'])
    const b = await c.req.parseBody()
    await run(c, (tx) => reverseScript(tx, c.req.param('id'), str(b.reason), c.get('user').userId))
    return back(c, `/dispensary/scripts/${c.req.param('id')}`, { ok: 'Script reversed; its stock is back on the shelf' })
  })

  r.post('/scripts/:id/repeat', async (c) => {
    const id = await run(c, (tx) => startRepeat(tx, c.req.param('id'), c.get('user').userId))
    return c.redirect(`/dispensary/scripts/${id}`)
  })

  r.get('/scripts/:id/labels', async (c) => {
    const { labels, shop, settings } = await run(c, async (tx) => ({
      labels: await labelsFor(tx, { scriptId: c.req.param('id') }, initials(c.get('user').name) ?? undefined),
      shop: await getShop(tx), settings: await getSettings(tx),
    }))
    return c.html(<LabelSheet labels={labels} shop={shop} settings={settings} />)
  })

  r.get('/supplies/:id/label', async (c) => {
    const { labels, shop, settings } = await run(c, async (tx) => ({
      labels: await labelsFor(tx, { supplyId: c.req.param('id') }), shop: await getShop(tx), settings: await getSettings(tx),
    }))
    return c.html(<LabelSheet labels={labels} shop={shop} settings={settings} />)
  })

  // ------------------------------------------------------------ owed items

  r.get('/owed', async (c) => {
    const owed = await run(c, (tx) => listOwed(tx))
    return page(c, 'Owed items', (
      <>
        <h1>Owed items</h1>
        <LabelLink id={c.req.query('label')} />
        <p class="muted">What dispensed scripts still owe patients. Hand it over here when stock arrives, then print a label for what was given.</p>
        <OwedTable owed={owed} canSupply={pharmacist(c)} showPatient />
      </>
    ))
  })

  r.post('/owed/:id/supply', async (c) => {
    requireRole(c, ['owner', 'pharmacist'])
    const b = await c.req.parseBody()
    const supplyId = await run(c, (tx) => supplyOwed(tx, c.req.param('id'), Number(str(b.units)), { allowNegative: b.allowNegative === 'on' }, c.get('user').userId))
    const from = str(b.from) || '/dispensary/owed'
    return back(c, `${from}${from.includes('?') ? '&' : '?'}label=${supplyId}`, { ok: 'Handed over' })
  })

  r.post('/owed/:id/cancel', async (c) => {
    requireRole(c, ['owner', 'pharmacist'])
    const b = await c.req.parseBody()
    await run(c, (tx) => cancelOwed(tx, c.req.param('id'), str(b.reason), c.get('user').userId))
    return back(c, str(b.from) || '/dispensary/owed', { ok: 'Owed item cancelled' })
  })

  // ------------------------------------------------------------ register

  r.get('/register', async (c) => {
    const range = await rangeFrom(c)
    const itemId = c.req.query('item') || undefined
    const reg = await run(c, async (tx) => register(tx, await bounds(tx, range), { itemId }))
    if (c.req.query('format') === 'csv') {
      c.header('content-type', 'text/csv')
      c.header('content-disposition', `attachment; filename="register-${range.from}-${range.to}.csv"`)
      return c.body(csv([
        ['Item', 'Schedule', 'Date', 'Entry', 'Patient', 'Patient ID', 'Patient address', 'Doctor', 'In', 'Out', 'Balance', 'By'],
        ...reg.items.flatMap((i) => i.entries.map((e) => [`${i.stockCode} ${i.description}`, i.schedule, dateTime(e.at), e.what, e.patient, e.patientIdNo,
          e.patientAddress, e.doctor, e.inUnits || '', e.outUnits || '', e.balance, e.by])),
      ]))
    }
    return page(c, 'Register', (
      <>
        <div class="row"><h1>Register of scheduled medicines</h1><span class="spacer" />
          <a class="btn secondary" href={`?from=${range.from}&to=${range.to}${itemId ? `&item=${itemId}` : ''}&format=csv`}>Download CSV</a>
          <button class="secondary" onclick="window.print()">Print</button></div>
        <RangeForm {...range} extra={itemId ? <input type="hidden" name="item" value={itemId} /> : undefined} />
        {!reg.schedules.length && !itemId
          ? <p class="msg err">No schedules are chosen for the register yet. Choose them under <a href="/dispensary/settings">Dispensing settings</a>.</p>
          : <p class="muted">{itemId ? 'One item' : `Schedules ${reg.schedules.join(', ')}`}, in units. Every entry comes from the stock ledger, so the balance always agrees with stock on hand.</p>}
        {reg.items.map((i) => (
          <div class="panel">
            <div class="row"><b>{i.description}</b><span class="muted">{i.stockCode} · S{i.schedule} · pack of {i.packSize}</span><span class="spacer" />
              <span>Opening <b>{i.opening}</b> · Closing <b>{i.closing}</b></span></div>
            <div class="wrap"><table>
              <thead><tr><th>Date</th><th>Entry</th><th>Patient</th><th>Doctor</th><th class="n">In</th><th class="n">Out</th><th class="n">Balance</th><th>By</th></tr></thead>
              <tbody>{i.entries.map((e) => (
                <tr><td>{dateTime(e.at)}</td><td>{e.what}</td>
                  <td>{e.patient}{e.patientIdNo && <div class="hint">ID {e.patientIdNo}</div>}{e.patientAddress && <div class="hint">{e.patientAddress}</div>}</td>
                  <td>{e.doctor}</td><td class="n">{e.inUnits || ''}</td><td class="n">{e.outUnits || ''}</td>
                  <td class={`n ${e.balance < 0 ? 'neg' : ''}`}>{e.balance}</td><td>{e.by}</td></tr>
              ))}</tbody>
            </table></div>
          </div>
        ))}
        {(reg.schedules.length > 0 || itemId) && !reg.items.length && <p class="muted">No registered items moved in this range.</p>}
      </>
    ))
  })

  // ------------------------------------------------------------ doctors

  r.get('/doctors', async (c) => {
    const q = c.req.query('q') ?? ''
    const doctors = await run(c, (tx) => listDoctors(tx, q))
    return page(c, 'Doctors', (
      <>
        <h1>Doctors</h1>
        <form class="row panel"><input name="q" data-search value={q} placeholder="Surname or practice number" style="flex:1" /><button class="secondary">Find</button></form>
        <form method="post" action="/dispensary/doctors" class="grid panel">
          <label>Surname<input name="surname" required /></label>
          <label>Initials<input name="initials" /></label>
          <label>Title<input name="title" value="Dr" /></label>
          <label>Practice number<input name="practiceNo" /></label>
          <label>Phone<input name="phone" /></label>
          <div><button>Add doctor</button></div>
        </form>
        <div class="wrap"><table>
          <thead><tr><th>Doctor</th><th>Practice number</th><th>Phone</th><th /></tr></thead>
          <tbody>{doctors.map((d) => (
            <tr data-href={`/dispensary/doctors/${d.id}`} class={d.active ? '' : 'muted'}><td><a href={`/dispensary/doctors/${d.id}`}>{d.name}</a></td><td>{d.practiceNo}</td><td>{d.phone}</td>
              <td>{!d.active && 'inactive'}</td></tr>
          ))}</tbody>
        </table></div>
      </>
    ))
  })

  r.post('/doctors', async (c) => {
    const b = await c.req.parseBody()
    await run(c, (tx) => saveDoctor(tx, { surname: str(b.surname), initials: str(b.initials), title: str(b.title), practiceNo: str(b.practiceNo), phone: str(b.phone) }, c.get('user').userId))
    return back(c, '/dispensary/doctors', { ok: 'Doctor added' })
  })

  r.get('/doctors/:id', async (c) => {
    const d = await run(c, (tx) => getDoctor(tx, c.req.param('id')))
    if (!d) throw new DomainError('unknown doctor', 'not_found', 404)
    return page(c, d.name, (
      <>
        <h1>{d.name}</h1>
        <form method="post" action={`/dispensary/doctors/${d.id}`} class="grid panel">
          <label>Surname<input name="surname" required value={d.surname} /></label>
          <label>Initials<input name="initials" value={d.initials ?? ''} /></label>
          <label>Title<input name="title" value={d.title} /></label>
          <label>Practice number<input name="practiceNo" value={d.practiceNo ?? ''} /></label>
          <label>Phone<input name="phone" value={d.phone ?? ''} /></label>
          <label class="row" style="flex-direction:row"><input type="checkbox" name="inactive" checked={!d.active} /> Inactive</label>
          <div><button>Save</button></div>
        </form>
      </>
    ))
  })

  r.post('/doctors/:id', async (c) => {
    const b = await c.req.parseBody()
    await run(c, (tx) => saveDoctor(tx, { id: c.req.param('id'), surname: str(b.surname), initials: str(b.initials), title: str(b.title),
      practiceNo: str(b.practiceNo), phone: str(b.phone), active: b.inactive !== 'on' }, c.get('user').userId))
    return back(c, '/dispensary/doctors', { ok: 'Saved' })
  })

  // ------------------------------------------------------------ settings

  r.get('/settings', async (c) => {
    const d = await run(c, async (tx) => ({
      s: await getSettings(tx), shop: await getShop(tx), next: await nextScriptNo(tx), aids: await listMedicalAids(tx), directions: await listDirections(tx),
    }))
    return page(c, 'Dispensing settings', (
      <>
        <h1>Dispensing settings</h1>
        <form method="post" action="/dispensary/settings" class="grid panel">
          <label>Dispensing fee per line, incl VAT (P)<input name="fee" type="number" step="0.01" min="0" value={d.s.dispensingFee.toFixed(2)} /></label>
          <label>Default supply days<input name="supplyDays" type="number" min="1" value={d.s.defaultSupplyDays} /></label>
          <label>Repeats valid for (days after the script date)<input name="repeatDays" type="number" min="1" value={d.s.repeatValidDays} /></label>
          <label>Schedules in the register (e.g. 2, 3)<input name="schedules" value={d.s.registerSchedules.join(', ')} /></label>
          <label>Next script number<input name="nextNo" type="number" min={d.next} value={d.next} /></label>
          <label>Label width (mm)<input name="labelW" type="number" min="30" max="150" value={d.s.labelWidthMm} /></label>
          <label>Label height (mm)<input name="labelH" type="number" min="20" max="150" value={d.s.labelHeightMm} /></label>
          <label>Label footer<input name="labelFooter" value={d.s.labelFooter ?? ''} /></label>
          <label>Shop address (on labels)<input name="address" value={d.shop.address ?? ''} /></label>
          <label>Shop phone (on labels)<input name="phone" value={d.shop.phone ?? ''} /></label>
          <div><button>Save</button></div>
        </form>
        <p class="hint">The next script number can only go up, so numbering can carry on from Compharm's. Which schedules must go in the register is for the pharmacist to confirm against Botswana's rules.</p>

        <h2>Medical aids</h2>
        <div class="wrap"><table>
          <thead><tr><th>Name</th><th>Code</th><th>Message on scripts</th><th /></tr></thead>
          <tbody>{d.aids.map((a) => (
            <tr><td colspan={4}>
              <form method="post" action={`/dispensary/settings/aids/${a.id}`} class="row">
                <input name="name" value={a.name} required /><input name="code" value={a.code ?? ''} placeholder="code" style="width:100px" />
                <input name="message" value={a.message ?? ''} placeholder="Shown on every script for its members" style="flex:1" />
                <label class="row" style="flex-direction:row"><input type="checkbox" name="inactive" checked={!a.active} /> inactive</label>
                <button class="secondary">Save</button>
              </form></td></tr>
          ))}</tbody>
        </table></div>
        <form method="post" action="/dispensary/settings/aids" class="row panel">
          <input name="name" required placeholder="e.g. BOMAid" /><input name="code" placeholder="code" style="width:100px" /><button>Add medical aid</button>
        </form>

        <h2>Label directions</h2>
        <p class="muted">Type a code on a script line and it becomes the text. Clear the text to delete a code.</p>
        <div class="wrap"><table>
          <tbody>{d.directions.map((x) => (
            <tr><td colspan={2}><form method="post" action="/dispensary/settings/directions" class="row">
              <input name="code" value={x.code} readonly style="width:110px" /><input name="text" value={x.text} style="flex:1" /><button class="secondary">Save</button>
            </form></td></tr>
          ))}</tbody>
        </table></div>
        <form method="post" action="/dispensary/settings/directions" class="row panel">
          <input name="code" required placeholder="Code, e.g. 2T2D" style="width:140px" /><input name="text" required placeholder="Take TWO tablets TWICE a day" style="flex:1" /><button>Add direction</button>
        </form>
      </>
    ))
  })

  r.post('/settings', async (c) => {
    requireRole(c, ['owner'])
    const b = await c.req.parseBody()
    const schedules = str(b.schedules).split(/[\s,]+/).filter(Boolean).map(Number)
    if (schedules.some((n) => !Number.isInteger(n) || n < 0 || n > 9)) throw new DomainError('schedules are whole numbers from 0 to 9')
    const nums = { fee: Number(b.fee), supplyDays: Number(b.supplyDays), repeatDays: Number(b.repeatDays), w: Number(b.labelW), h: Number(b.labelH) }
    if (!(nums.fee >= 0) || !(nums.supplyDays >= 1) || !(nums.repeatDays >= 1) || !(nums.w >= 30 && nums.w <= 150) || !(nums.h >= 20 && nums.h <= 150)) {
      throw new DomainError('check the numbers: fee zero or more, days at least 1, labels 30-150 mm wide and 20-150 mm high')
    }
    await run(c, async (tx) => {
      await updateSettings(tx, {
        dispensingFee: Math.round(nums.fee * 100) / 100, defaultSupplyDays: Math.round(nums.supplyDays), repeatValidDays: Math.round(nums.repeatDays),
        labelWidthMm: Math.round(nums.w), labelHeightMm: Math.round(nums.h), labelFooter: str(b.labelFooter) || null,
      }, c.get('user').userId)
      await tx`update tenant_settings set register_schedules = ${[...new Set(schedules)].sort()}::smallint[]`
      await updateShop(tx, { address: str(b.address) || null, phone: str(b.phone) || null })
      const next = Number(str(b.nextNo))
      if (next !== (await nextScriptNo(tx))) await setNextScriptNo(tx, next)
    })
    return back(c, '/dispensary/settings', { ok: 'Settings saved' })
  })

  r.post('/settings/aids', async (c) => {
    requireRole(c, ['owner', 'pharmacist'])
    const b = await c.req.parseBody()
    await run(c, (tx) => saveMedicalAid(tx, { name: str(b.name), code: str(b.code) }, c.get('user').userId))
    return back(c, '/dispensary/settings', { ok: 'Medical aid added' })
  })

  r.post('/settings/aids/:id', async (c) => {
    requireRole(c, ['owner', 'pharmacist'])
    const b = await c.req.parseBody()
    await run(c, (tx) => saveMedicalAid(tx, { id: c.req.param('id'), name: str(b.name), code: str(b.code), message: str(b.message), active: b.inactive !== 'on' }, c.get('user').userId))
    return back(c, '/dispensary/settings', { ok: 'Saved' })
  })

  r.post('/settings/directions', async (c) => {
    requireRole(c, ['owner', 'pharmacist'])
    const b = await c.req.parseBody()
    await run(c, (tx) => saveDirection(tx, str(b.code), str(b.text), c.get('user').userId))
    return back(c, '/dispensary/settings', { ok: 'Directions saved' })
  })

  return r
}

function LabelLink({ id }: { id?: string }) {
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null
  return <p class="panel"><a class="btn" href={`/dispensary/supplies/${id}/label?print`} target="_blank">Print the label for what was just handed over</a></p>
}

function OwedTable({ owed, canSupply, showPatient }: { owed: Awaited<ReturnType<typeof listOwed>>; canSupply: boolean; showPatient?: boolean }) {
  if (!owed.length) return <p class="muted">Nothing is owed.</p>
  return (
    <div class="wrap"><table>
      <thead><tr><th>Since</th>{showPatient && <th>Patient</th>}<th>Script</th><th>Item</th><th class="n">Owed</th><th class="n">On hand</th>{canSupply && <th>Hand over</th>}</tr></thead>
      <tbody>{owed.map((o) => (
        <tr>
          <td>{date(o.since)}</td>
          {showPatient && <td><a href={`/dispensary/patients/${o.patientId}`}>{o.patientName}</a>{o.phone && <div class="hint">{o.phone}</div>}</td>}
          <td><a href={`/dispensary/scripts/${o.scriptId}`}>{o.scriptNo}</a></td>
          <td>{o.description} <span class="muted">{o.stockCode}</span></td>
          <td class="n">{o.leftUnits}{o.suppliedUnits > 0 && <div class="hint">of {o.owedUnits}</div>}</td>
          <td class={`n ${o.onHandUnits < o.leftUnits ? 'neg' : ''}`}>{o.onHandUnits}</td>
          {canSupply && <td>
            <form method="post" action={`/dispensary/owed/${o.id}/supply`} class="row">
              <input type="hidden" name="from" value={showPatient ? '/dispensary/owed' : `/dispensary/patients/${o.patientId}`} />
              <input name="units" type="number" min="1" max={o.leftUnits} value={Math.min(o.leftUnits, Math.max(o.onHandUnits, 1))} style="width:70px" />
              {o.onHandUnits < o.leftUnits && <label class="row hint" style="flex-direction:row" title="Stock shows less than this"><input type="checkbox" name="allowNegative" /> override</label>}
              <button class="secondary">Give</button>
            </form>
            <details><summary class="hint">Cancel</summary>
              <form method="post" action={`/dispensary/owed/${o.id}/cancel`} class="row">
                <input type="hidden" name="from" value={showPatient ? '/dispensary/owed' : `/dispensary/patients/${o.patientId}`} />
                <input name="reason" required placeholder="Why" /><button class="danger">Cancel owed</button>
              </form>
            </details>
          </td>}
        </tr>
      ))}</tbody>
    </table></div>
  )
}

/** Dispensing labels, one per page, sized for the shop's label printer. */
function LabelSheet({ labels, shop, settings }: { labels: Label[]; shop: { name: string; address: string | null; phone: string | null };
  settings: { labelWidthMm: number; labelHeightMm: number; labelFooter: string | null } }) {
  const w = settings.labelWidthMm
  const h = settings.labelHeightMm
  const css = `
@page{size:${w}mm ${h}mm;margin:0}
*{box-sizing:border-box}body{margin:0;font:9pt/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#000;background:#fff}
.label{width:${w}mm;height:${h}mm;padding:2mm 3mm;overflow:hidden;page-break-after:always;display:flex;flex-direction:column;gap:.6mm}
.label:last-child{page-break-after:auto}
.shop{font-size:7pt;display:flex;justify-content:space-between;border-bottom:.2mm solid #000;padding-bottom:.4mm}
.top{display:flex;justify-content:space-between;font-weight:700}
.item{font-weight:700;font-size:9.5pt}.dir{font-size:10pt;flex:1}
.foot{font-size:6.5pt;display:flex;justify-content:space-between;gap:2mm}
@media screen{body{background:#ddd;padding:12px;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;align-content:flex-start}.label{background:#fff;box-shadow:0 1px 4px #0003}.bar{width:100%}}
@media print{.bar{display:none}}`
  return (
    <html lang="en">
      <head><meta charset="utf-8" /><title>Labels · sylken</title><style>{raw(css)}</style></head>
      <body>
        <div class="bar"><button onclick="window.print()">Print {labels.length} label{labels.length === 1 ? '' : 's'}</button> <a href="javascript:history.back()">Back</a></div>
        {labels.map((l) => (
          <div class="label">
            <div class="shop"><span>{shop.name}{shop.address ? ` · ${shop.address}` : ''}</span><span>{shop.phone ?? ''}</span></div>
            <div class="top"><span>{l.patientName}</span><span>{date(l.date)}</span></div>
            <div class="item">{l.description} <span style="font-weight:400">× {l.qtyUnits}</span></div>
            <div class="dir">{l.directions}</div>
            <div class="foot"><span>Rx {l.scriptNo ?? ''}{l.doctorName ? ` · ${l.doctorName}` : ''}{l.dispenser ? ` · ${l.dispenser}` : ''}{l.note ? ` · ${l.note}` : ''}</span>
              <span>{settings.labelFooter ?? ''}</span></div>
          </div>
        ))}
        <script>{raw('if(location.search.includes("print"))window.print()')}</script>
      </body>
    </html>
  )
}
