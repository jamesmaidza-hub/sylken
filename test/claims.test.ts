import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { claimBatchFile, claimCandidates, claimDateTime, claimFileName, claimXml, createClaimBatch, listClaimBatches, splitNappi } from '../src/domain/claims.js'
import { createItem } from '../src/domain/items.js'
import { createPatient, saveDoctor, saveMedicalAid } from '../src/domain/patients.js'
import { shopToday } from '../src/domain/sales.js'
import { addLine, createDraft, dispenseScript, reverseScript, startRepeat } from '../src/domain/scripts.js'
import { updateSettings } from '../src/domain/settings.js'
import { postMovements } from '../src/domain/stock.js'
import { createApp } from '../src/web/app.js'
import { appDb, newTenant, webLogin } from './helpers.js'

let db: Sql
let t: Awaited<ReturnType<typeof newTenant>>
beforeAll(async () => { db = appDb(); t = await newTenant(db) })
afterAll(async () => { await db.end() })

const today = () => shopToday('Africa/Gaborone')
const tag = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map((m) => m[1])

/** Every element opened is closed, in order: the file is well-formed enough for a parser. */
function balanced(xml: string) {
  const stack: string[] = []
  for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z]+)>/g)) {
    if (!m[1]) stack.push(m[2])
    else if (stack.pop() !== m[2]) return false
  }
  return stack.length === 0
}

describe('claim file format', () => {
  it('formats dates, NAPPI codes and file names as the Allegra Connect spec asks', () => {
    expect(claimDateTime(new Date('2026-10-28T06:05:09Z'), 'Africa/Gaborone')).toBe('2026-10-28-08-05-09')
    expect(splitNappi('708564-001')).toEqual({ code: '708564', extended: '001' })
    expect(splitNappi('708564')).toEqual({ code: '708564', extended: null })
    expect(claimFileName('2026-10-28', 7)).toBe('ClaimsFile28102026_007.xml')
  })

  it('escapes text and leaves out empty optional elements', () => {
    const xml = claimXml({
      batchNo: 1, batchDate: '2026-10-28', schemeCode: 'PULA', planCode: 'PULA', practiceNo: '60086', practiceName: 'Friends & Co Pharmacy',
      test: true, timezone: 'Africa/Gaborone', claims: [{
        kind: 'Request', scriptId: 'x', scriptNo: 10, dispensedAt: new Date('2026-10-27T08:00:00Z'), prescriberPracticeNo: '123', prescriberName: null,
        member: { memberNo: 'M1', firstName: 'Kagiso Neo', surname: "O'NEIL", title: null },
        patient: { firstName: 'Kagiso Neo', surname: "O'NEIL", dateOfBirth: '1980-01-02', sex: 'U', idNo: null, dependantNo: '00' },
        lines: [{ lineNo: 1, nappiCode: '700001', description: 'PANADO <500>', treatmentDate: '2026-10-27', qtyUnits: 20, daysSupplied: 5,
          gross: 30, fee: 0, vat: 3.68, icd10: [], originalScriptNo: null, repeatNo: null, repeatsAuthorised: null }],
      }],
    })
    expect(balanced(xml)).toBe(true)
    expect(xml).toContain('<providerName>Friends &amp; Co Pharmacy</providerName>')
    expect(xml).toContain('<memberSurname>O&apos;NEIL</memberSurname>')
    expect(xml).toContain('<chargeableDescription>PANADO &lt;500&gt;</chargeableDescription>')
    expect(tag(xml, 'memberInitials')).toEqual(['KN'])
    expect(tag(xml, 'memberFirstName')).toEqual(['Kagiso'])
    expect(xml).not.toMatch(/<(\w+)\/>|<(\w+)><\/\2>/)             // no empty elements
    expect(xml).not.toContain('<Diagnoses>')
    expect(xml).not.toContain('extendedCode')
    expect(tag(xml, 'testClaim')).toEqual(['true'])
  })
})

describe('claim batches', () => {
  it('claims dispensed scripts once, leaves out the ones with problems, and reverses claims later', async () => {
    const s = await t.as(async (tx) => {
      await updateSettings(tx, { practiceNo: '60086' })
      const amx = await createItem(tx, { stockCode: 'AMX', description: 'AMOXIL 500MG CAPS', packSize: 15, sellLoose: true, costPerPack: 30, nappiCode: '708564-001' })
      const pan = await createItem(tx, { stockCode: 'PAN', description: 'PANADO TABS', packSize: 24, sellLoose: true, costPerPack: 12, nappiCode: '700001' })
      const odd = await createItem(tx, { stockCode: 'ODD', description: 'NO NAPPI CREAM', packSize: 1, costPerPack: 20 })
      await postMovements(tx, [amx, pan, odd].map((i) => ({ itemId: i.id, kind: 'opening' as const, qtyUnits: 500 })))
      const aid = await saveMedicalAid(tx, { name: 'Pula Medical Aid', code: 'PULA' })
      const other = await saveMedicalAid(tx, { name: 'BOMAid', code: 'BOMAID' })
      const doc = await saveDoctor(tx, { surname: 'Molefe', initials: 'K', practiceNo: '0421234' })
      const noNo = await saveDoctor(tx, { surname: 'Dube' })
      const main = await createPatient(tx, { surname: 'MOTHIBI', firstNames: 'Kagiso', title: 'Mr', sex: 'M', dateOfBirth: '1975-03-04',
        idNo: '123456789', medicalAidId: aid, memberNo: 'P100200', phone: '71000000' })
      const child = await createPatient(tx, { surname: 'MOTHIBI', firstNames: 'Lesedi', sex: 'F', dateOfBirth: '2015-06-07', mainMemberId: main, dependantCode: '01' })
      const nodob = await createPatient(tx, { surname: 'SEBOKO', firstNames: 'Neo', medicalAidId: aid, memberNo: 'P300400' })
      const bomaid = await createPatient(tx, { surname: 'TAU', firstNames: 'Mpho', dateOfBirth: '1990-01-01', medicalAidId: other, memberNo: 'B1' })
      return { amx, pan, odd, aid, doc, noNo, main, child, nodob, bomaid }
    })
    const dispense = (patientId: string, doctorId: string, lines: { itemId: string; qtyUnits: number; icd10?: string[]; noClaim?: boolean; repeats?: number; supplyDays?: number }[]) =>
      t.as(async (tx) => {
        const id = await createDraft(tx, { patientId, doctorId, rxDate: today() })
        for (const l of lines) await addLine(tx, id, { ...l, directions: '1T3D' })
        await dispenseScript(tx, id, { confirmed: true }, t.userId)
        return id
      })
    const s1 = await dispense(s.main, s.doc, [
      { itemId: s.amx.id, qtyUnits: 15, icd10: ['J06.9', 'R50.9'], repeats: 1, supplyDays: 5 },
      { itemId: s.pan.id, qtyUnits: 24, noClaim: true },                // patient pays: stays out of the claim
    ])
    const s2 = await dispense(s.child, s.doc, [{ itemId: s.pan.id, qtyUnits: 12 }])
    const s3 = await dispense(s.nodob, s.noNo, [{ itemId: s.odd.id, qtyUnits: 1 }])
    await dispense(s.bomaid, s.doc, [{ itemId: s.pan.id, qtyUnits: 12 }])  // another medical aid
    const range = { from: today(), to: today() }

    const cands = await t.as((tx) => claimCandidates(tx, s.aid, range))
    expect(cands.map((x) => x.scriptId)).toEqual([s1, s2, s3])
    expect(cands[2].problems).toEqual(["the patient's date of birth is missing", 'Dr Dube has no practice number', 'no NAPPI code for NO NAPPI CREAM'])

    // A test file can be made as often as needed; it doesn't count as claimed.
    const trial = await t.as((tx) => createClaimBatch(tx, { medicalAidId: s.aid, ...range, test: true }, t.userId))
    expect(tag(trial.xml, 'testClaim')).toEqual(['true', 'true'])
    expect((await t.as((tx) => claimCandidates(tx, s.aid, range))).length).toBe(3)

    const b1 = await t.as((tx) => createClaimBatch(tx, { medicalAidId: s.aid, ...range }, t.userId))
    expect(b1).toMatchObject({ claims: 2, left: [{ scriptId: s3 }] })
    const xml = b1.xml
    expect(balanced(xml)).toBe(true)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<ClaimBatch>')).toBe(true)
    expect(tag(xml, 'schemeName')).toEqual(['PULA'])
    expect(tag(xml, 'testClaim')).toEqual(['false', 'false'])
    expect(tag(xml, 'providerType')).toEqual(['BP', 'BP'])
    expect(tag(xml, 'providerBHF')).toEqual(['60086', '60086'])
    expect(tag(xml, 'prescribingProviderBHF')).toEqual(['0421234', '0421234'])
    expect(tag(xml, 'membershipNo')).toEqual(['P100200', 'P100200'])
    expect(tag(xml, 'memberFirstName')).toEqual(['KAGISO', 'KAGISO'])
    expect(tag(xml, 'beneficiaryFirstName')).toEqual(['KAGISO', 'LESEDI'])
    expect(tag(xml, 'dependantNo')).toEqual(['00', '01'])
    expect(tag(xml, 'beneficiaryDOB')).toEqual(['1975-03-04', '2015-06-07'])
    expect(tag(xml, 'beneficiaryGender')).toEqual(['M', 'F'])
    expect(tag(xml, 'chargeableCode')).toEqual(['708564', '700001'])
    expect(tag(xml, 'extendedCode')).toEqual(['001'])
    expect(tag(xml, 'chargeableQuantity')).toEqual(['1500', '1200'])
    expect(tag(xml, 'daysSupplied')[0]).toBe('5')
    expect(tag(xml, 'numLines')).toEqual(['1', '1'])                 // the patient-pays line is not claimed
    expect(tag(xml, 'code')).toEqual(['J06.9', 'R50.9', 'J06.9', 'R50.9'])
    expect(tag(xml, 'qualifier')).toEqual(['P', 'S', 'P', 'S'])
    const gross = tag(xml, 'grossAmount').map(Number)
    expect(tag(xml, 'claimGross').map(Number)).toEqual(gross)
    expect(Number(tag(xml, 'batchTotal')[0])).toBeCloseTo(gross[0] + gross[1], 2)
    expect(b1.total).toBeCloseTo(gross[0] + gross[1], 2)
    expect(tag(xml, 'numClaims')).toEqual(['2'])
    expect(b1.fileName).toMatch(/^ClaimsFile\d{8}_\d{3}\.xml$/)
    expect((await t.as((tx) => claimBatchFile(tx, b1.id))).xml).toBe(xml)

    // Claimed scripts don't come up again; the one with problems still does.
    expect((await t.as((tx) => claimCandidates(tx, s.aid, range))).map((x) => x.scriptId)).toEqual([s3])
    await expect(t.as((tx) => createClaimBatch(tx, { medicalAidId: s.aid, ...range }, t.userId))).rejects.toThrow(/fix the problems/)

    // A repeat says which script it repeats; a reversed claim goes in the next file as a reversal.
    const rep = await t.as((tx) => startRepeat(tx, s1, t.userId))
    await t.as((tx) => dispenseScript(tx, rep, { confirmed: true }, t.userId))
    await t.as((tx) => reverseScript(tx, s2, 'wrong patient', t.userId))
    const b2 = await t.as((tx) => createClaimBatch(tx, { medicalAidId: s.aid, ...range }, t.userId))
    expect(tag(b2.xml, 'transactionType')).toEqual(['Reversal', 'Request'])
    const [s1no] = await t.as((tx) => tx`select script_no from scripts where id = ${s1}`)
    expect(tag(b2.xml, 'originalScriptNo')).toEqual([String(s1no.script_no)])
    expect(tag(b2.xml, 'repeatNo')).toEqual(['1'])
    expect(tag(b2.xml, 'repeatAuthorised')).toEqual(['1'])

    const list = await t.as((tx) => listClaimBatches(tx))
    expect(list.map((b) => [b.numClaims, b.test])).toEqual([[2, false], [2, false], [2, true]])
    await expect(t.as((tx) => tx`delete from claim_batches where id = ${b1.id}`)).rejects.toThrow(/never changed/)
  })

  it("won't make a file without the practice number and the scheme code", async () => {
    const other = await newTenant(db)
    const aid = await other.as((tx) => saveMedicalAid(tx, { name: 'Pula Medical Aid' }))
    await expect(other.as((tx) => createClaimBatch(tx, { medicalAidId: aid, from: today(), to: today() }))).rejects.toThrow(/practice number/)
    await other.as((tx) => updateSettings(tx, { practiceNo: '60086' }))
    await expect(other.as((tx) => createClaimBatch(tx, { medicalAidId: aid, from: today(), to: today() }))).rejects.toThrow(/scheme code/)
  })

  it('makes and downloads a claim file from the screens', async () => {
    const w = await newTenant(db)
    const app = createApp(db)
    const cookie = `${await webLogin(app, w.email, w.password)}; rx_code=${w.staffCode}`
    const { aid } = await w.as(async (tx) => {
      await updateSettings(tx, { practiceNo: '60086' })
      const item = await createItem(tx, { stockCode: 'PAN', description: 'PANADO TABS', packSize: 24, sellLoose: true, costPerPack: 12, nappiCode: '700001' })
      await postMovements(tx, [{ itemId: item.id, kind: 'opening', qtyUnits: 100 }])
      const aid = await saveMedicalAid(tx, { name: 'Pula Medical Aid', code: 'PULA' })
      const doc = await saveDoctor(tx, { surname: 'Molefe', practiceNo: '0421234' })
      const p = await createPatient(tx, { surname: 'TAU', firstNames: 'Mpho', dateOfBirth: '1990-01-01', medicalAidId: aid, memberNo: 'P1' })
      const id = await createDraft(tx, { patientId: p, doctorId: doc, rxDate: today() })
      await addLine(tx, id, { itemId: item.id, qtyUnits: 24, directions: '1T3D' })
      await dispenseScript(tx, id, { confirmed: true }, w.userId)
      return { aid }
    })
    const screen = await app.request(`/dispensary/claims?aid=${aid}`, { headers: { cookie } })
    expect(screen.status).toBe(200)
    expect(await screen.text()).toContain('1 script ready')
    const made = await app.request('/dispensary/claims', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ aid, from: today(), to: today() }) })
    expect(new URL(made.headers.get('location') ?? '', 'http://x').searchParams.get('ok')).toMatch(/Claim file ClaimsFile\d{8}_\d{3}\.xml made: 1 claim/)
    const [b] = await w.as((tx) => listClaimBatches(tx))
    const file = await app.request(`/dispensary/claims/${b.id}/xml`, { headers: { cookie } })
    expect(file.headers.get('content-disposition')).toBe(`attachment; filename="${b.fileName}"`)
    expect(await file.text()).toContain('<membershipNo>P1</membershipNo>')
  })
})
