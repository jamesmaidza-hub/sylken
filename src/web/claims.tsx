import { Hono } from 'hono'
import { claimBatchFile, claimCandidates, createClaimBatch, listClaimBatches } from '../domain/claims.js'
import { listMedicalAids } from '../domain/patients.js'
import { getSettings } from '../domain/settings.js'
import { back, page, run, type Env } from './app.js'
import { RangeForm, rangeFrom, thisMonth } from './cashup.js'
import { RxToolbar } from './dispensary.js'
import { date, dateTime, money } from './layout.js'

const str = (v: unknown) => String(v ?? '').trim()

/**
 * Medical aid claim files: pick the medical aid and the dispensing days, see which scripts can
 * be claimed and which need fixing first, then make the XML batch file and download it.
 */
export function claimRoutes() {
  const r = new Hono<Env>()

  r.get('/', async (c) => {
    const range = await rangeFrom(c, thisMonth)
    const test = c.req.query('test') === 'on'
    const d = await run(c, async (tx) => {
      const aids = (await listMedicalAids(tx, { activeOnly: true }))
      const aidId = c.req.query('aid') || aids[0]?.id
      return {
        aids, aidId, settings: await getSettings(tx), batches: await listClaimBatches(tx),
        candidates: aidId ? await claimCandidates(tx, aidId, range, { test }) : [],
      }
    })
    const ready = d.candidates.filter((x) => !x.problems.length)
    const aid = d.aids.find((a) => a.id === d.aidId)
    const keep = `aid=${d.aidId ?? ''}${test ? '&test=on' : ''}`
    return page(c, 'Medical aid claims', (
      <>
        <RxToolbar />
        <h1>Medical aid claims</h1>
        <p class="muted">Makes the claim file the medical aid's switch takes (Allegra Connect XML, as AFA uses for Pula Medical Aid Fund).
          Each dispensed script billed to the medical aid goes in once. A script reversed after it was sent goes in the next file as a reversal.</p>
        {!d.settings.practiceNo && <p class="msg err">Set the pharmacy's practice number under <a href="/dispensary/settings">Dispensing settings</a> first.</p>}
        {aid && !aid.code && <p class="msg err">{aid.name} has no scheme code yet. Add it under <a href="/dispensary/settings">Dispensing settings</a>.</p>}
        <RangeForm from={range.from} to={range.to} today={range.today} keep={keep} extra={<>
          <label class="f">Medical aid<select name="aid">{d.aids.map((a) => <option value={a.id} selected={a.id === d.aidId}>{a.name}</option>)}</select></label>
          <label class="row" style="flex-direction:row"><input type="checkbox" name="test" checked={test} /> Test file</label>
        </>} />
        <div class="wrap"><table>
          <thead><tr><th>Script</th><th>Dispensed</th><th>Patient</th><th>Member no</th><th>Type</th><th class="num">Claim</th><th>Can it be claimed?</th></tr></thead>
          <tbody>{d.candidates.map((x) => (
            <tr class={x.problems.length ? 'muted' : ''}>
              <td><a href={`/dispensary/scripts/${x.scriptId}`}>{x.scriptNo}</a></td><td>{dateTime(x.dispensedAt)}</td><td>{x.patient}</td><td>{x.memberNo}</td>
              <td>{x.kind === 'Reversal' ? 'Reversal' : 'Claim'}</td><td class="num">{money(x.amount)}</td>
              <td>{x.problems.length ? <span class="neg">Fix first: {x.problems.join('; ')}</span> : 'Ready'}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {!d.candidates.length && <p class="hint">No scripts to claim for these dates.</p>}
        {ready.length > 0 && (
          <form method="post" action="/dispensary/claims" class="row panel">
            <input type="hidden" name="aid" value={d.aidId} /><input type="hidden" name="from" value={range.from} /><input type="hidden" name="to" value={range.to} />
            {test && <input type="hidden" name="test" value="on" />}
            <span>{ready.length} script{ready.length === 1 ? '' : 's'} ready, {money(ready.reduce((a, x) => a + x.amount, 0))}
              {test ? '. A test file is marked as a test and the scripts can still be claimed for real.' : '.'}</span>
            <span class="spacer" /><button>Make {test ? 'test ' : ''}claim file</button>
          </form>
        )}

        <h2>Claim files made</h2>
        <div class="wrap"><table>
          <thead><tr><th>Batch</th><th>Made</th><th>Medical aid</th><th>Dispensed</th><th class="num">Claims</th><th class="num">Total</th><th>By</th><th /></tr></thead>
          <tbody>{d.batches.map((b) => (
            <tr><td>{b.batchNo}{b.test ? ' (test)' : ''}</td><td>{dateTime(b.createdAt)}</td><td>{b.medicalAid}</td><td>{date(b.from)} to {date(b.to)}</td>
              <td class="num">{b.numClaims}</td><td class="num">{money(b.total)}</td><td>{b.createdBy}</td>
              <td><a class="btn secondary" href={`/dispensary/claims/${b.id}/xml`}>{b.fileName}</a></td></tr>
          ))}</tbody>
        </table></div>
      </>
    ))
  })

  r.post('/', async (c) => {
    const b = await c.req.parseBody()
    const q = `aid=${encodeURIComponent(str(b.aid))}&from=${str(b.from)}&to=${str(b.to)}${b.test === 'on' ? '&test=on' : ''}`
    const made = await run(c, (tx) => createClaimBatch(tx, { medicalAidId: str(b.aid), from: str(b.from), to: str(b.to), test: b.test === 'on' }, c.get('user').userId))
    return back(c, `/dispensary/claims?${q}`, {
      ok: `Claim file ${made.fileName} made: ${made.claims} claim${made.claims === 1 ? '' : 's'}, ${money(made.total)}.${made.left.length ? ` ${made.left.length} left out to fix.` : ''}`,
    })
  })

  r.get('/:id/xml', async (c) => {
    const f = await run(c, (tx) => claimBatchFile(tx, c.req.param('id')))
    c.header('content-type', 'application/xml; charset=utf-8')
    c.header('content-disposition', `attachment; filename="${f.fileName}"`)
    return c.body(f.xml)
  })

  return r
}
