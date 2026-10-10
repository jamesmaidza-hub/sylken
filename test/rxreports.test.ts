import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { createItem, updateItem } from '../src/domain/items.js'
import { addFlag, createPatient, saveDoctor, saveMedicalAid } from '../src/domain/patients.js'
import { drugUsage, lastVisit, patientList, priceChanges, repeatsDue, reversedScripts, scriptAnalysis } from '../src/domain/rxreports.js'
import { shopToday } from '../src/domain/sales.js'
import { addLine, createDraft, dispenseScript, reverseScript, startRepeat } from '../src/domain/scripts.js'
import { postMovements } from '../src/domain/stock.js'
import { appDb, newTenant } from './helpers.js'

let db: Sql
let t: Awaited<ReturnType<typeof newTenant>>
beforeAll(async () => { db = appDb(); t = await newTenant(db) })
afterAll(async () => { await db.end() })

const today = () => shopToday('Africa/Gaborone')
const plus = (days: number) => new Date(Date.parse(today() + 'T00:00:00Z') + days * 86400_000).toISOString().slice(0, 10)

describe('dispensary reports', () => {
  it('counts what was dispensed by item, by medical aid and by doctor, and finds repeats due and patients', async () => {
    const { a, b, aid, doc, mainId, privId } = await t.as(async (tx) => {
      const a = await createItem(tx, { stockCode: 'AMX', description: 'AMOXIL 500', packSize: 10, sellLoose: true, costPerPack: 20, schedule: 2 })
      const b = await createItem(tx, { stockCode: 'PAN', description: 'PANADO', packSize: 10, sellLoose: true, costPerPack: 10 })
      await postMovements(tx, [{ itemId: a.id, kind: 'opening', qtyUnits: 200 }, { itemId: b.id, kind: 'opening', qtyUnits: 200 }])
      const aid = await saveMedicalAid(tx, { name: 'BOMAid' })
      const doc = await saveDoctor(tx, { surname: 'Molefe', initials: 'K' })
      const mainId = await createPatient(tx, { surname: 'MOTHIBI', firstNames: 'Kagiso', medicalAidId: aid, memberNo: 'B1', phone: '71000000' })
      const privId = await createPatient(tx, { surname: 'SEBOKO', firstNames: 'Neo' })
      await addFlag(tx, mainId, { kind: 'allergy', text: 'SULFA' })
      return { a, b, aid, doc, mainId, privId }
    })
    const dispense = (patientId: string, lines: { itemId: string; qtyUnits: number; repeats?: number; supplyDays?: number }[]) =>
      t.as(async (tx) => {
        const sid = await createDraft(tx, { patientId, doctorId: doc, rxDate: today() })
        for (const l of lines) await addLine(tx, sid, { ...l, directions: '1T3D' })
        await dispenseScript(tx, sid, { confirmed: true }, t.userId)
        return sid
      })
    const s1 = await dispense(mainId, [{ itemId: a.id, qtyUnits: 30, repeats: 2, supplyDays: 10 }, { itemId: b.id, qtyUnits: 20 }])
    await dispense(privId, [{ itemId: a.id, qtyUnits: 10 }])
    const gone = await dispense(privId, [{ itemId: b.id, qtyUnits: 10 }])
    await t.as((tx) => reverseScript(tx, gone, 'wrong patient', t.userId))
    const range = { from: today(), to: today() }

    const usage = await t.as((tx) => drugUsage(tx, range))
    expect(usage.map((u) => [u.stockCode, u.scripts, u.patients, u.units])).toEqual([['AMX', 2, 2, 40], ['PAN', 1, 1, 20]])
    expect(usage[0].cost).toBe(80)                               // 40 units at P2 each
    expect(usage[0].gp).toBeCloseTo(usage[0].excl - 80, 2)
    expect((await t.as((tx) => drugUsage(tx, range, { schedule: 2 }))).map((u) => u.stockCode)).toEqual(['AMX'])

    const byAid = await t.as((tx) => scriptAnalysis(tx, range, 'aid'))
    expect(byAid.rows.map((r) => [r.key, r.scripts, r.lines])).toEqual(expect.arrayContaining([['BOMAid', 1, 2], ['Private', 1, 1]]))
    expect(byAid.totals).toMatchObject({ scripts: 2, newScripts: 2, repeats: 0, patients: 2 })
    expect((await t.as((tx) => scriptAnalysis(tx, range, 'doctor'))).rows.map((r) => r.key)).toEqual(['Dr K Molefe'])

    // The repeat falls due ten days after the original was dispensed, until a repeat is given.
    const due = await t.as((tx) => repeatsDue(tx, { from: today(), to: plus(30) }))
    expect(due).toMatchObject([{ scriptId: s1, description: 'AMOXIL 500', repeatsLeft: 2, due: plus(10), daysOverdue: -10, phone: '71000000' }])
    const rep = await t.as((tx) => startRepeat(tx, s1, t.userId))
    await t.as((tx) => dispenseScript(tx, rep, { confirmed: true }, t.userId))
    expect(await t.as((tx) => repeatsDue(tx, { from: today(), to: plus(30) }))).toMatchObject([{ repeatsLeft: 1, due: plus(10) }])
    expect((await t.as((tx) => scriptAnalysis(tx, range, 'day'))).totals).toMatchObject({ scripts: 3, newScripts: 2, repeats: 1 })

    const pats = await t.as((tx) => patientList(tx, range))
    expect(pats.map((p) => [p.name, p.scripts, p.allergies, p.dependantCode])).toEqual([['KAGISO MOTHIBI', 2, 'SULFA', '00'], ['NEO SEBOKO', 1, null, null]])
    expect((await t.as((tx) => patientList(tx, range, { aidId: 'private' }))).map((p) => p.name)).toEqual(['NEO SEBOKO'])
    expect((await t.as((tx) => lastVisit(tx, range))).length).toBe(2)
    expect(await t.as((tx) => lastVisit(tx, { from: plus(-400), to: plus(-1) }))).toEqual([])

    const rev = await t.as((tx) => reversedScripts(tx, range))
    expect(rev).toMatchObject([{ id: gone, reason: 'wrong patient', patient: 'NEO SEBOKO' }])
  })

  it('lists price changes with the price before and after', async () => {
    const i = await t.as((tx) => createItem(tx, { stockCode: 'VIT', description: 'VITAMIN C', packSize: 1, costPerPack: 10 }))
    const before = i.retailPerPack
    await t.as((tx) => updateItem(tx, i.id, { retailPerPack: 25 }, t.userId))
    const rows = (await t.as((tx) => priceChanges(tx, { from: today(), to: today() }))).filter((r) => r.stockCode === 'VIT')
    expect(rows).toMatchObject([{ oldRetail: before, newRetail: 25, source: 'manual', by: 'Owner' }])
    expect(await t.as((tx) => priceChanges(tx, { from: today(), to: today() }, { source: 'receipt' }))).toEqual([])
  })
})
