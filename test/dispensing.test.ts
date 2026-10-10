import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { createItem, getItem } from '../src/domain/items.js'
import {
  addFlag, allergyHits, createPatient, expandDirections, familyOf, getPatient, saveDoctor, saveMedicalAid, searchPatients, updatePatient,
} from '../src/domain/patients.js'
import {
  addLine, createDraft, discardDraft, dispenseScript, getScript, labelsFor, listOwed, parseIcd10, priceLine, register, removeLine,
  reverseScript, scriptBook, scriptForTill, setSupply, startRepeat, supplyOwed,
} from '../src/domain/scripts.js'
import { updateSettings } from '../src/domain/settings.js'
import { postMovements } from '../src/domain/stock.js'
import { listTills, openRun, recordSale } from '../src/domain/till.js'
import { appDb, newTenant } from './helpers.js'

let db: Sql
let t: Awaited<ReturnType<typeof newTenant>>
let aidId: string
let doctorId: string

beforeAll(async () => {
  db = appDb()
  t = await newTenant(db)
  aidId = await t.as((tx) => saveMedicalAid(tx, { name: 'BOMAid' }))
  doctorId = await t.as((tx) => saveDoctor(tx, { surname: 'Molefe', initials: 'k', practiceNo: 'BW123' }))
})
afterAll(async () => { await db.end() })

const today = () => new Date().toISOString().slice(0, 10)

const item = (code: string, extra: Record<string, unknown> = {}, stock = 100) =>
  t.as(async (tx) => {
    const i = await createItem(tx, { stockCode: code, description: `ITEM ${code}`, packSize: 10, sellLoose: true, costPerPack: 20, ...extra })
    if (stock) await postMovements(tx, [{ itemId: i.id, kind: 'opening', qtyUnits: stock }])
    return i
  })

const member = (surname = 'MOTHIBI', memberNo = `M${randomUUID().slice(0, 6)}`) =>
  t.as((tx) => createPatient(tx, { surname, firstNames: 'Kagiso', medicalAidId: aidId, memberNo, idNo: '123456789', address: 'Plot 1, Gaborone' }))

const onHand = async (id: string) => (await t.as((tx) => getItem(tx, id)))!.onHandUnits

describe('patients', () => {
  it('keeps dependants under the main member, sharing the medical aid', async () => {
    const mainId = await member('SETSHEDI', 'BOM-777')
    const depId = await t.as((tx) => createPatient(tx, { surname: 'Setshedi', firstNames: 'Neo', mainMemberId: mainId, dateOfBirth: '2015-03-02' }))
    const dep = (await t.as((tx) => getPatient(tx, depId)))!
    expect(dep).toMatchObject({ medicalAidName: 'BOMAid', memberNo: 'BOM-777', dependantCode: '01', mainMemberId: mainId })
    const fam = await t.as(async (tx) => familyOf(tx, (await getPatient(tx, mainId))!))
    expect(fam.map((p) => p.dependantCode)).toEqual(['00', '01'])
    expect((await t.as((tx) => searchPatients(tx, 'bom-777'))).length).toBe(2)
    expect((await t.as((tx) => searchPatients(tx, 'setsh neo'))).map((p) => p.id)).toEqual([depId])
    expect((await t.as((tx) => searchPatients(tx, 'setshedi', { mainMembersOnly: true }))).map((p) => p.id)).toEqual([mainId])
    expect((await t.as((tx) => searchPatients(tx, 'setsh neo', { mainMembersOnly: true }))).map((p) => p.id)).toEqual([mainId])
    await expect(t.as((tx) => createPatient(tx, { surname: 'X', mainMemberId: depId }))).rejects.toThrow(/main member/)
    await expect(t.as((tx) => createPatient(tx, { surname: 'Y', medicalAidId: aidId, memberNo: 'BOM-777' }))).rejects.toThrow(/dependant/)
    await expect(t.as((tx) => updatePatient(tx, mainId, { surname: 'SETSHEDI', mainMemberId: depId }))).rejects.toThrow()
  })

  it('keeps a private account number and lets the dependant code be corrected', async () => {
    const mainId = await t.as((tx) => createPatient(tx, { surname: 'KGOSI', memberNo: 'acc-42', dependantCode: '0' }))
    expect((await t.as((tx) => getPatient(tx, mainId)))).toMatchObject({ medicalAidName: null, memberNo: 'ACC-42', dependantCode: '00' })
    const depId = await t.as((tx) => createPatient(tx, { surname: 'Kgosi', firstNames: 'Lesedi', mainMemberId: mainId }))
    await t.as((tx) => updatePatient(tx, mainId, { surname: 'KGOSI', firstNames: 'Neo', memberNo: 'ACC-42', dependantCode: '00' }))
    expect((await t.as((tx) => getPatient(tx, mainId)))!.memberNo).toBe('ACC-42')
    expect((await t.as((tx) => searchPatients(tx, 'acc-42'))).length).toBe(2)
    await t.as((tx) => updatePatient(tx, depId, { surname: 'KGOSI', firstNames: 'Lesedi', mainMemberId: mainId, dependantCode: '3' }))
    expect((await t.as((tx) => getPatient(tx, depId)))!.dependantCode).toBe('03')
    await expect(t.as((tx) => updatePatient(tx, depId, { surname: 'KGOSI', mainMemberId: mainId, dependantCode: 'A1' }))).rejects.toThrow(/dependant code/)
  })

  it('expands direction codes and flags allergies written like the item name', async () => {
    expect(await t.as((tx) => expandDirections(tx, '1t3d'))).toBe('Take ONE tablet THREE times a day')
    expect(await t.as((tx) => expandDirections(tx, 'Two puffs when needed'))).toBe('Two puffs when needed')
    expect(allergyHits(['AMOXICILLIN', 'SULFA'], 'AMOXICILLIN 500MG CAPS')).toEqual(['AMOXICILLIN'])
    expect(allergyHits(['PENICILLIN'], 'AMOXIL 500MG')).toEqual([])
  })

  it('checks ICD-10 codes by shape and prices lines with the fee', () => {
    expect(parseIcd10('j06.9, z76.9')).toEqual(['J06.9', 'Z76.9'])
    expect(() => parseIcd10('flu')).toThrow(/ICD-10/)
    expect(priceLine(34.2, 10, 30, 0.14, 11.4, 0.14)).toEqual({ itemTotal: 102.6, fee: 11.4, lineTotal: 114, vat: 14 })
  })
})

describe('dispensing a script', () => {
  it('captures a draft, dispenses it once, takes stock, records owed items and freezes it', async () => {
    await t.as((tx) => updateSettings(tx, { dispensingFee: 11.4 }))
    const a = await item('RX-1')                      // retail 34.20 per pack of 10
    const b = await item('RX-2', {}, 5)
    const pid = await member()
    const sid = await t.as((tx) => createDraft(tx, { patientId: pid, doctorId, rxDate: today() }))
    await t.as((tx) => addLine(tx, sid, { itemId: a.id, qtyUnits: 30, directions: '1T3D', repeats: 2, icd10: 'J06.9' }))
    await t.as((tx) => addLine(tx, sid, { itemId: b.id, qtyUnits: 20, supplyUnits: 5, directions: '1tn', noClaim: true }))
    const d = (await t.as((tx) => getScript(tx, sid)))!
    expect(d.status).toBe('draft')
    expect(d.lines.map((l) => l.lineTotal)).toEqual([114, 79.8])
    expect(d.lines[0].directions).toBe('Take ONE tablet THREE times a day')
    expect(d).toMatchObject({ total: 193.8, claimTotal: 114, patientTotal: 79.8, medicalAidName: 'BOMAid' })

    const { scriptNo } = await t.as((tx) => dispenseScript(tx, sid, {}, t.userId))
    const s = (await t.as((tx) => getScript(tx, sid)))!
    expect(s).toMatchObject({ status: 'dispensed', scriptNo, claimTotal: 114, patientTotal: 79.8, medicalAidName: 'BOMAid' })
    expect(s.lines[1].owedUnits).toBe(15)
    expect(await onHand(a.id)).toBe(70)
    expect(await onHand(b.id)).toBe(0)
    await expect(t.as((tx) => dispenseScript(tx, sid, {}, t.userId))).rejects.toThrow(/already dispensed/)
    await expect(t.as((tx) => addLine(tx, sid, { itemId: a.id, qtyUnits: 1, directions: 'AD' }))).rejects.toThrow(/already dispensed/)
    await expect(t.as((tx) => tx`update script_lines set qty_units = 1 where script_id = ${sid}`)).rejects.toThrow(/dispensed/)
    await expect(t.as((tx) => tx`update scripts set total = 1 where id = ${sid}`)).rejects.toThrow(/only be reversed/)

    const labels = await t.as((tx) => labelsFor(tx, { scriptId: sid }))
    expect(labels.map((l) => [l.qtyUnits, l.note])).toEqual([[30, '2 repeats'], [5, null]])
    expect(labels[0].doctorName).toBe('Dr K Molefe')

    // The owed balance is handed over later, in two goes.
    await t.as((tx) => postMovements(tx, [{ itemId: b.id, kind: 'receipt', qtyUnits: 50 }]))
    const [owed] = await t.as((tx) => listOwed(tx, { patientId: pid }))
    expect(owed).toMatchObject({ leftUnits: 15, scriptNo })
    const supplyId = await t.as((tx) => supplyOwed(tx, owed.id, 10, {}, t.userId))
    await t.as((tx) => supplyOwed(tx, owed.id, 5, {}, t.userId))
    await expect(t.as((tx) => supplyOwed(tx, owed.id, 1, {}, t.userId))).rejects.toThrow(/between 1 and 0/)
    expect(await t.as((tx) => listOwed(tx, { patientId: pid }))).toEqual([])
    expect((await t.as((tx) => labelsFor(tx, { supplyId })))[0]).toMatchObject({ qtyUnits: 10, note: 'Balance of owed item' })
    expect(await onHand(b.id)).toBe(35)
  })

  it('makes the pharmacist confirm allergies and alerts, and blocks short stock unless overridden', async () => {
    const pen = await item('AMOX', { description: 'AMOXICILLIN 500MG' }, 10)
    const pid = await member()
    await t.as((tx) => addFlag(tx, pid, { kind: 'allergy', text: 'amoxicillin', detail: 'rash' }))
    const sid = await t.as((tx) => createDraft(tx, { patientId: pid, doctorId, rxDate: today() }))
    await t.as((tx) => addLine(tx, sid, { itemId: pen.id, qtyUnits: 15, directions: '1C3D' }))
    await expect(t.as((tx) => dispenseScript(tx, sid, {}, t.userId))).rejects.toThrow(/allergies/)
    await expect(t.as((tx) => dispenseScript(tx, sid, { confirmed: true }, t.userId))).rejects.toThrow(/stock shows 10/)
    await t.as((tx) => dispenseScript(tx, sid, { confirmed: true, allowNegative: true }, t.userId))
    expect(await onHand(pen.id)).toBe(-5)
  })

  it('needs the doctor for items in the register, and shows the register with running balances', async () => {
    await t.as((tx) => tx`update tenant_settings set register_schedules = '{6}'`)
    const morph = await item('SCH6', { description: 'CONTROLLED SYRUP', schedule: 6 }, 50)
    const pid = await member('KGOSI')
    const noDoc = await t.as((tx) => createDraft(tx, { patientId: pid, rxDate: today() }))
    await t.as((tx) => addLine(tx, noDoc, { itemId: morph.id, qtyUnits: 10, directions: 'AD' }))
    await expect(t.as((tx) => dispenseScript(tx, noDoc, {}, t.userId))).rejects.toThrow(/needs its doctor/)
    await t.as((tx) => discardDraft(tx, noDoc))
    expect(await t.as((tx) => getScript(tx, noDoc))).toBeNull()

    const sid = await t.as((tx) => createDraft(tx, { patientId: pid, doctorId, rxDate: today() }))
    await t.as((tx) => addLine(tx, sid, { itemId: morph.id, qtyUnits: 10, directions: 'AD' }))
    const { scriptNo } = await t.as((tx) => dispenseScript(tx, sid, {}, t.userId))
    const start = new Date(Date.now() - 86_400_000)
    const reg = await t.as((tx) => register(tx, { start, end: new Date(Date.now() + 60_000) }))
    const row = reg.items.find((i) => i.itemId === morph.id)!
    expect(row.entries.map((e) => [e.what, e.inUnits, e.outUnits, e.balance])).toEqual([
      ['Opening stock', 50, 0, 50], [`Script ${scriptNo}`, 0, 10, 40],
    ])
    expect(row.entries[1]).toMatchObject({ patient: 'KAGISO KGOSI', patientIdNo: '123456789', doctor: 'Dr K Molefe (BW123)' })
    const book = await t.as((tx) => scriptBook(tx, { start, end: new Date(Date.now() + 60_000) }))
    expect(book.find((b) => b.scriptNo === scriptNo)).toMatchObject({ patientName: 'KAGISO KGOSI', items: 'CONTROLLED SYRUP x10' })
  })

  it('counts repeats against the original script and stops when they run out', async () => {
    const a = await item('REP')
    const pid = await member()
    const sid = await t.as((tx) => createDraft(tx, { patientId: pid, doctorId, rxDate: today() }))
    await t.as((tx) => addLine(tx, sid, { itemId: a.id, qtyUnits: 10, directions: '1T1D', repeats: 1 }))
    await t.as((tx) => addLine(tx, sid, { itemId: a.id, qtyUnits: 5, directions: 'PRN' }))
    await t.as((tx) => dispenseScript(tx, sid, {}, t.userId))
    const r1 = await t.as((tx) => startRepeat(tx, sid, t.userId))
    expect(await t.as((tx) => startRepeat(tx, sid, t.userId))).toBe(r1)       // the open repeat is reused
    const draft = (await t.as((tx) => getScript(tx, r1)))!
    expect(draft.lines.map((l) => l.qtyUnits)).toEqual([10])                    // only the line with a repeat
    expect(draft.repeatNo).toBe(1)
    await t.as((tx) => setSupply(tx, r1, draft.lines[0].id, 4))
    await t.as((tx) => dispenseScript(tx, r1, {}, t.userId))
    const after = (await t.as((tx) => getScript(tx, sid)))!
    expect(after.lines[0].repeatsLeft).toBe(0)
    expect((await t.as((tx) => getScript(tx, r1)))!.lines[0].owedUnits).toBe(6)
    await expect(t.as((tx) => startRepeat(tx, r1, t.userId))).rejects.toThrow(/no repeats left/)
    expect(await onHand(a.id)).toBe(100 - 10 - 5 - 4)
    await expect(t.as((tx) => reverseScript(tx, sid, 'wrong patient', t.userId))).rejects.toThrow(/repeats of this script/)
  })

  it('refuses repeats once the script is too old', async () => {
    const a = await item('OLD')
    const pid = await member()
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10)
    const sid = await t.as((tx) => createDraft(tx, { patientId: pid, doctorId, rxDate: old }))
    await t.as((tx) => addLine(tx, sid, { itemId: a.id, qtyUnits: 10, directions: '1T1D', repeats: 3 }))
    await expect(t.as((tx) => dispenseScript(tx, sid, {}, t.userId))).rejects.toThrow(/Tick/)    // old script: confirm
    await t.as((tx) => dispenseScript(tx, sid, { confirmed: true }, t.userId))
    await expect(t.as((tx) => startRepeat(tx, sid, t.userId))).rejects.toThrow(/ran out/)
  })

  it('is paid at the till by script number without taking the stock twice, and reverses only once refunded', async () => {
    const a = await item('TILLRX')
    const pid = await member()
    const sid = await t.as((tx) => createDraft(tx, { patientId: pid, doctorId, rxDate: today() }))
    await t.as((tx) => addLine(tx, sid, { itemId: a.id, qtyUnits: 20, supplyUnits: 10, directions: '1T2D' }))
    await t.as((tx) => addLine(tx, sid, { itemId: a.id, qtyUnits: 10, directions: 'AD', noClaim: true }))
    const { scriptNo } = await t.as((tx) => dispenseScript(tx, sid, {}, t.userId))
    expect(await onHand(a.id)).toBe(80)
    const look = (await t.as((tx) => scriptForTill(tx, scriptNo)))!
    expect(look).toMatchObject({ claimTotal: 79.8, patientTotal: 45.6, medicalAid: 'BOMAid', paid: 0 })

    const tillId = (await t.as(listTills))[0].id
    const runId = randomUUID()
    await t.as((tx) => openRun(tx, { id: runId, tillId, openingFloat: 0, openedAt: new Date() }))
    const saleId = randomUUID()
    const lines = look.lines.map((l) => ({ itemId: l.itemId, qtyUnits: l.qtyUnits, listTotal: l.lineTotal, lineTotal: l.lineTotal, scriptLineId: l.scriptLineId }))
    await t.as((tx) => recordSale(tx, {
      id: saleId, runId, kind: 'sale', occurredAt: new Date(), scriptId: sid, medicalAid: 'BOMAid', memberNo: look.memberNo, lines,
      payments: [{ tender: 'medical_aid', amount: 79.8 }, { tender: 'cash', amount: 45.6 }],
    }))
    expect(await onHand(a.id)).toBe(80)                                       // stock left when dispensed, not again
    expect((await t.as((tx) => scriptForTill(tx, scriptNo)))!.paid).toBe(125.4)
    await expect(t.as((tx) => reverseScript(tx, sid, 'wrong item', t.userId))).rejects.toThrow(/refund it there first/)

    const other = await t.as((tx) => createDraft(tx, { patientId: pid, rxDate: today() }))
    await expect(t.as((tx) => recordSale(tx, {
      id: randomUUID(), runId, kind: 'sale', occurredAt: new Date(), scriptId: other, lines, payments: [{ tender: 'cash', amount: 125.4 }],
    }))).rejects.toThrow(/not dispensed/)

    await t.as((tx) => recordSale(tx, {
      id: randomUUID(), runId, kind: 'refund', refundOf: saleId, occurredAt: new Date(), scriptId: sid,
      lines: lines.map((l) => ({ ...l, qtyUnits: -l.qtyUnits, listTotal: -l.listTotal, lineTotal: -l.lineTotal })),
      payments: [{ tender: 'cash', amount: -125.4 }],
    }))
    expect(await onHand(a.id)).toBe(80)
    await t.as((tx) => reverseScript(tx, sid, 'wrong item', t.userId))
    expect(await onHand(a.id)).toBe(100)
    const rev = (await t.as((tx) => getScript(tx, sid)))!
    expect(rev).toMatchObject({ status: 'reversed', reverseReason: 'wrong item' })
    expect(rev.lines[0].owedUnits).toBe(0)
    await expect(t.as((tx) => removeLine(tx, sid, rev.lines[0].id))).rejects.toThrow(/dispensed/)
  })

  it('does not let a patient pay through the medical aid when told not to bill it', async () => {
    const a = await item('PRIV')
    const pid = await member()
    const sid = await t.as((tx) => createDraft(tx, { patientId: pid, rxDate: today(), billMedicalAid: false }))
    await t.as((tx) => addLine(tx, sid, { itemId: a.id, qtyUnits: 10, directions: 'AD' }))
    await t.as((tx) => dispenseScript(tx, sid, {}, t.userId))
    expect(await t.as((tx) => getScript(tx, sid))).toMatchObject({ claimTotal: 0, patientTotal: 45.6, medicalAidName: null, memberNo: null })
  })
})
