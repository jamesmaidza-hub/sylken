import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { accountStatement, ageAnalysis, createAccount, postAccountEntry } from '../src/domain/accounts.js'
import { createItem, getItem } from '../src/domain/items.js'
import { dailySales, itemGp, salesSummary, shopToday } from '../src/domain/sales.js'
import { postMovements } from '../src/domain/stock.js'
import {
  applyTillOps, closeRun, getSale, linePrice, listTills, roundCash, openRun, recordSale, recordTillEntry, runSummary, vatIn,
  type SaleInput,
} from '../src/domain/till.js'
import { purgeTenant } from '../src/domain/tenants.js'
import { adminDb, appDb, newTenant } from './helpers.js'

let db: Sql
let admin: Sql
let t: Awaited<ReturnType<typeof newTenant>>
let tillId: string

beforeAll(async () => {
  db = appDb()
  admin = adminDb()
  t = await newTenant(db)
  tillId = (await t.as(listTills))[0].id
})
afterAll(async () => { await db.end(); await admin.end() })

const item = (code: string, extra: Record<string, unknown> = {}) =>
  t.as(async (tx) => {
    const i = await createItem(tx, { stockCode: code, description: `Item ${code}`, packSize: 10, costPerPack: 20, ...extra })
    await postMovements(tx, [{ itemId: i.id, kind: 'opening', qtyUnits: 100 }])
    return i
  })

const newRun = async (float = 200) => {
  const id = randomUUID()
  await t.as((tx) => openRun(tx, { id, tillId, openingFloat: float, openedAt: new Date() }))
  return id
}

const sale = (runId: string, lines: SaleInput['lines'], payments: SaleInput['payments'], extra: Partial<SaleInput> = {}): SaleInput => ({
  id: randomUUID(), runId, kind: 'sale', occurredAt: new Date(), lines, payments, ...extra,
})

describe('till pricing', () => {
  it('prices whole packs exactly and loose units as a fraction of the pack', () => {
    expect(linePrice(34.2, 10, 20)).toBe(68.4)
    expect(linePrice(34.2, 10, 3)).toBe(10.26)
    expect(linePrice(50, 100, 30)).toBe(15)
    expect(vatIn(114, 0.14)).toBe(14)
  })

  it('rounds cash to the nearest 5 thebe', () => {
    expect(roundCash(15.69, 0.05)).toBe(15.7)
    expect(roundCash(15.67, 0.05)).toBe(15.65)
    expect(roundCash(15.625, 0.05)).toBe(15.65)
    expect(roundCash(-15.69, 0.05)).toBe(-15.7)
    expect(roundCash(15.69, 0.01)).toBe(15.69)
  })
})

describe('sales', () => {
  it('records a sale once: lines, tenders, stock, VAT and cost', async () => {
    const i = await item('S-1')                       // retail 34.20 a pack of 10, cost 2.00 a unit
    const run = await newRun()
    const s = sale(run, [{ itemId: i.id, qtyUnits: 20, listTotal: 68.4, lineTotal: 68.4 }], [{ tender: 'cash', amount: 68.4 }], { cashTendered: 100 })
    const first = await t.as((tx) => recordSale(tx, s))
    const again = await t.as((tx) => recordSale(tx, s))
    expect(first.recorded).toBe(true)
    expect(again).toEqual({ recorded: false, saleNo: first.saleNo })
    const got = (await t.as((tx) => getSale(tx, s.id)))!
    expect(got.total).toBe(68.4)
    expect(got.vat).toBe(8.4)
    expect(got.cost).toBe(40)
    expect(got.change).toBe(31.6)
    expect((await t.as((tx) => getItem(tx, i.id)))!.onHandUnits).toBe(80)
  })

  it('refuses sales whose payments do not add up, or with the wrong signs', async () => {
    const i = await item('S-2')
    const run = await newRun()
    const line = { itemId: i.id, qtyUnits: 10, listTotal: 34.2, lineTotal: 34.2 }
    await expect(t.as((tx) => recordSale(tx, sale(run, [line], [{ tender: 'cash', amount: 30 }])))).rejects.toThrow(/don't add up/)
    await expect(t.as((tx) => recordSale(tx, sale(run, [{ ...line, qtyUnits: -10 }], [{ tender: 'cash', amount: 34.2 }])))).rejects.toThrow(/positive/)
    await expect(t.as((tx) => recordSale(tx, sale(run, [line], [{ tender: 'account', amount: 34.2 }])))).rejects.toThrow(/customer account/)
    await expect(t.as((tx) => recordSale(tx, sale(run, [line], [{ tender: 'medical_aid', amount: 34.2 }])))).rejects.toThrow(/medical aid name/)
    await expect(t.as((tx) => recordSale(tx, sale(run, [line], [{ tender: 'cash', amount: 34.2 }], { cashTendered: 20 })))).rejects.toThrow(/less than/)
  })

  it('records an offline sale even when the item went quarantined or the stock ran out', async () => {
    const i = await item('S-3', { status: 'quarantined' })
    const run = await newRun()
    await t.as((tx) => recordSale(tx, sale(run, [{ itemId: i.id, qtyUnits: 150, listTotal: 513, lineTotal: 513 }], [{ tender: 'card', amount: 513 }])))
    expect((await t.as((tx) => getItem(tx, i.id)))!.onHandUnits).toBe(-50)
  })

  it('takes cash rounded to 5 thebe and keeps the rounding apart from the sale', async () => {
    const i = await item('S-R', { costPerPack: 9.18 })              // retail 15.70 a pack: sell 7 units for 10.99
    const run = await newRun(0)
    const line = { itemId: i.id, qtyUnits: 7, listTotal: 10.99, lineTotal: 10.99 }
    const s = sale(run, [line], [{ tender: 'cash', amount: 11 }], { rounding: 0.01, cashTendered: 20 })
    await t.as((tx) => recordSale(tx, s))
    const got = (await t.as((tx) => getSale(tx, s.id)))!
    expect([got.total, got.rounding, got.change]).toEqual([10.99, 0.01, 9])
    expect((await t.as((tx) => runSummary(tx, run)))!.expected.cash).toBe(11)
    await expect(t.as((tx) => recordSale(tx, sale(run, [line], [{ tender: 'card', amount: 11 }], { rounding: 0.01 })))).rejects.toThrow(/only a cash payment/)
    await expect(t.as((tx) => recordSale(tx, sale(run, [line], [{ tender: 'cash', amount: 11.1 }], { rounding: 0.11 })))).rejects.toThrow(/more than half/)
  })

  it('never lets a sale be edited or deleted', async () => {
    const i = await item('S-4')
    const run = await newRun()
    const s = sale(run, [{ itemId: i.id, qtyUnits: 10, listTotal: 34.2, lineTotal: 34.2 }], [{ tender: 'cash', amount: 34.2 }])
    await t.as((tx) => recordSale(tx, s))
    await expect(t.as((tx) => tx`update sales set total = 1 where id = ${s.id}`)).rejects.toThrow(/never edited/)
    await expect(t.as((tx) => tx`delete from sale_payments where sale_id = ${s.id}`)).rejects.toThrow(/never edited/)
  })

  it('puts a refund back on the shelf and pays the money out', async () => {
    const i = await item('S-5')
    const run = await newRun()
    const s = sale(run, [{ itemId: i.id, qtyUnits: 10, listTotal: 34.2, lineTotal: 34.2 }], [{ tender: 'cash', amount: 34.2 }])
    await t.as((tx) => recordSale(tx, s))
    await t.as((tx) => recordSale(tx, sale(run, [{ itemId: i.id, qtyUnits: -10, listTotal: -34.2, lineTotal: -34.2 }],
      [{ tender: 'cash', amount: -34.2 }], { kind: 'refund', refundOf: s.id })))
    expect((await t.as((tx) => getItem(tx, i.id)))!.onHandUnits).toBe(100)
    const sum = (await t.as((tx) => runSummary(tx, run)))!
    expect(sum.byTender.cash).toBe(0)
    expect(sum.sales).toMatchObject({ count: 1, refunds: 1, total: 0 })
  })
})

describe('customer accounts', () => {
  it('charges account sales, takes payments at the till and ages what is owed', async () => {
    const i = await item('A-1')
    const acc = await t.as((tx) => createAccount(tx, { accountNo: 'acc1', name: 'Mrs Molefe', creditLimit: 1000 }))
    await expect(t.as((tx) => createAccount(tx, { accountNo: 'ACC1', name: 'Again' }))).rejects.toThrow(/already exists/)
    const run = await newRun()
    const old = new Date(Date.now() - 45 * 86_400_000)
    await t.as((tx) => recordSale(tx, sale(run, [{ itemId: i.id, qtyUnits: 30, listTotal: 102.6, lineTotal: 102.6 }],
      [{ tender: 'account', amount: 102.6 }], { accountId: acc, occurredAt: old })))
    await t.as((tx) => recordSale(tx, sale(run, [{ itemId: i.id, qtyUnits: 10, listTotal: 34.2, lineTotal: 34.2 }],
      [{ tender: 'account', amount: 20 }, { tender: 'cash', amount: 14.2 }], { accountId: acc })))
    await t.as((tx) => recordTillEntry(tx, { id: randomUUID(), runId: run, kind: 'account_payment', tender: 'cash', amount: 50, accountId: acc, occurredAt: new Date() }))
    const st = (await t.as((tx) => accountStatement(tx, acc)))!
    expect(st.balance).toBe(72.6)
    const age = (await t.as((tx) => ageAnalysis(tx))).find((a) => a.id === acc)!
    expect(age).toMatchObject({ balance: 72.6, current: 20, d30: 52.6, d60: 0, d90: 0 })   // the payment cleared the oldest charge first
    await t.as((tx) => postAccountEntry(tx, acc, { kind: 'adjustment', amount: -2.6, note: 'rounding' }))
    expect((await t.as((tx) => accountStatement(tx, acc)))!.balance).toBe(70)
  })
})

describe('a full trading day', () => {
  it('rings up a day and cashes it up the way POSWin lays it out', async () => {
    const panado = await item('DAY-1', { costPerPack: 10 })            // retail 17.10 a pack of 10
    const vitc = await item('DAY-2', { costPerPack: 50, packSize: 1, vatRate: 0 })   // zero-rated: retail 75.00
    const acc = await t.as((tx) => createAccount(tx, { accountNo: 'DAY', name: 'Clinic account' }))
    const runA = await newRun(200)
    const runB = randomUUID()
    const ops = [
      { type: 'open_run' as const, data: { id: runB, tillId, openingFloat: 150, openedAt: new Date() } },
      // Run B: rung up offline and synced later.
      { type: 'sale' as const, data: sale(runB, [{ itemId: panado.id, qtyUnits: 20, listTotal: 34.2, lineTotal: 34.2 }], [{ tender: 'cash', amount: 34.2 }], { cashTendered: 50 }) },
      { type: 'sale' as const, data: sale(runB, [{ itemId: vitc.id, qtyUnits: 2, listTotal: 150, lineTotal: 140 }], [{ tender: 'card', amount: 140, reference: '0042' }]) },
      { type: 'till_entry' as const, data: { id: randomUUID(), runId: runB, kind: 'petty_cash' as const, tender: 'cash' as const, amount: 25, note: 'Milk', occurredAt: new Date() } },
    ]
    const results = await t.as((tx) => applyTillOps(tx, tillId, ops, t.userId))
    expect(results.map((r) => r.status)).toEqual(['recorded', 'recorded', 'recorded', 'recorded'])
    expect((await t.as((tx) => applyTillOps(tx, tillId, ops, t.userId))).map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate'])

    // Run A: a mix of tenders.
    await t.as(async (tx) => {
      await recordSale(tx, sale(runA, [{ itemId: panado.id, qtyUnits: 10, listTotal: 17.1, lineTotal: 17.1 }], [{ tender: 'cash', amount: 17.1 }]))
      await recordSale(tx, sale(runA, [{ itemId: vitc.id, qtyUnits: 1, listTotal: 75, lineTotal: 75 }], [{ tender: 'eft', amount: 75, reference: 'FNB 991' }]))
      await recordSale(tx, sale(runA, [{ itemId: panado.id, qtyUnits: 30, listTotal: 51.3, lineTotal: 51.3 }],
        [{ tender: 'medical_aid', amount: 41.3 }, { tender: 'cash', amount: 10 }], { medicalAid: 'BOMAid', memberNo: '123' }))
      await recordSale(tx, sale(runA, [{ itemId: vitc.id, qtyUnits: 2, listTotal: 150, lineTotal: 150 }], [{ tender: 'account', amount: 150 }], { accountId: acc }))
      await recordTillEntry(tx, { id: randomUUID(), runId: runA, kind: 'account_payment', tender: 'card', amount: 60, accountId: acc, occurredAt: new Date() })
      await recordTillEntry(tx, { id: randomUUID(), runId: runA, kind: 'petty_cash', tender: 'cash', amount: 10, note: 'Stamps', occurredAt: new Date() })
    })

    const a = (await t.as((tx) => runSummary(tx, runA)))!
    expect(a.expected).toEqual({ cash: 217.1, card: 60, cheque: 0, eft: 75 })       // 200 float + 17.10 + 10 - 10 petty
    await expect(t.as((tx) => closeRun(tx, runA, { counted: { cash: 210, card: 60, cheque: 0 }, floatKept: 300 }))).rejects.toThrow(/float kept/)
    const closedA = await t.as((tx) => closeRun(tx, runA, { counted: { cash: 215.1, card: 60, cheque: 0 }, floatKept: 200 }))
    expect(closedA.surplus).toBe(-2)                                                  // P2 short
    await expect(t.as((tx) => closeRun(tx, runA, { counted: { cash: 1, card: 0, cheque: 0 }, floatKept: 0 }))).rejects.toThrow(/already cashed up/)
    await t.as((tx) => closeRun(tx, runB, { counted: { cash: 159.2, card: 140, cheque: 0 }, floatKept: 150 }))   // 150 + 34.20 - 25 exactly

    // A sale from run A that only reaches the server now is kept, and flagged.
    await t.as((tx) => recordSale(tx, sale(runA, [{ itemId: panado.id, qtyUnits: 10, listTotal: 17.1, lineTotal: 17.1 }], [{ tender: 'cash', amount: 17.1 }])))
    expect((await t.as((tx) => runSummary(tx, runA)))!.late).toEqual({ count: 1, total: 17.1 })

    const today = shopToday('Africa/Gaborone')
    const sum = await t.as((tx) => salesSummary(tx, { from: today, to: today }))
    const mine = sum.rows.filter((r) => r.run.id === runA || r.run.id === runB)
    expect(mine).toHaveLength(2)
    const rowA = mine.find((r) => r.run.id === runA)!
    // The late sale was in the drawer when it was counted, so with it the run is P19.10 short, not P2.
    expect(rowA).toMatchObject({ cash: 34.2, card: 60, cheque: 0, totalTill: 94.2, counted: 75.1, surplus: -19.1, directBank: 75 })
    expect(sum.warnings.some((w) => w.includes(`Run ${rowA.run.runNo}`) && w.includes('after cash-up'))).toBe(true)

    // Only this test's runs, so the blocks can be checked to the thebe.
    const only = await t.as((tx) => salesSummary(tx, { from: today, to: today, tillId }))
    const day = only.rows.filter((r) => r.run.id === runA || r.run.id === runB)
    expect(day.reduce((s, r) => s + r.run.sales.total, 0)).toBeCloseTo(34.2 + 140 + 17.1 + 75 + 51.3 + 150 + 17.1, 2)

    const daily = await t.as((tx) => dailySales(tx, { from: today, to: today }))
    expect(daily.rows).toHaveLength(1)
    expect(daily.totals.total).toBeCloseTo(daily.rows[0].total, 2)
    const gp = await t.as((tx) => itemGp(tx, { from: today, to: today }))
    const vitcGp = gp.find((g) => g.itemId === vitc.id)!
    expect(vitcGp).toMatchObject({ units: 5, total: 365, excl: 365, cost: 250, gp: 115, discount: 10 })
  })

  it('splits payments, bank and turnover blocks consistently', async () => {
    const t2 = await newTenant(db)
    const till2 = (await t2.as(listTills))[0].id
    const i = await t2.as(async (tx) => {
      const it = await createItem(tx, { stockCode: 'X', description: 'X', packSize: 1, costPerPack: 10, retailPerPack: 20 })
      await postMovements(tx, [{ itemId: it.id, kind: 'opening', qtyUnits: 100 }])
      return it
    })
    const acc = await t2.as((tx) => createAccount(tx, { accountNo: 'A', name: 'A' }))
    const run = randomUUID()
    const line = (n: number) => [{ itemId: i.id, qtyUnits: n, listTotal: 20 * n, lineTotal: 20 * n }]
    await t2.as(async (tx) => {
      await openRun(tx, { id: run, tillId: till2, openingFloat: 100, openedAt: new Date() })
      await recordSale(tx, { ...sale(run, line(1), [{ tender: 'cash', amount: 20 }]) })
      await recordSale(tx, { ...sale(run, line(2), [{ tender: 'card', amount: 40 }]) })
      await recordSale(tx, { ...sale(run, line(3), [{ tender: 'eft', amount: 60 }]) })
      await recordSale(tx, { ...sale(run, line(4), [{ tender: 'medical_aid', amount: 80 }], { medicalAid: 'BOMAid' }) })
      await recordSale(tx, { ...sale(run, line(5), [{ tender: 'account', amount: 100 }], { accountId: acc }) })
      await recordTillEntry(tx, { id: randomUUID(), runId: run, kind: 'account_payment', tender: 'cash', amount: 30, accountId: acc, occurredAt: new Date() })
      await recordTillEntry(tx, { id: randomUUID(), runId: run, kind: 'petty_cash', tender: 'cash', amount: 5, note: 'Bread', occurredAt: new Date() })
      await closeRun(tx, run, { counted: { cash: 145, card: 40, cheque: 0 }, floatKept: 100 })
    })
    const today = shopToday('Africa/Gaborone')
    const s = await t2.as((tx) => salesSummary(tx, { from: today, to: today }))
    expect(s.payments).toEqual({
      cashSales: 120, accountPayments: 30, medAid: 80, total: 230, lessMedAid: 80, lessPettyCash: 5, subtotal: 145,
      lessDirectBank: 60, totalPayments: 85,
    })
    expect(s.bank).toEqual({ creditCard: 40, depAmount: 45, total: 85, surplus: 0, runsNotCounted: 0 })
    expect(s.turnover).toEqual({ cashSales: 120, accountSales: 100, medicalFund: 80, total: 300 })
    expect(s.warnings).toEqual([])
    await purgeTenant(admin, t2.id)
  })
})

describe('till sync', () => {
  it('rejects a bad operation, keeps it for the back office and carries on with the rest', async () => {
    const i = await item('SYNC-1')
    const run = randomUUID()
    const good = sale(run, [{ itemId: i.id, qtyUnits: 10, listTotal: 34.2, lineTotal: 34.2 }], [{ tender: 'cash', amount: 34.2 }])
    const bad = sale(run, [{ itemId: i.id, qtyUnits: 10, listTotal: 34.2, lineTotal: 34.2 }], [{ tender: 'cash', amount: 3 }])
    const orphan = sale(randomUUID(), [{ itemId: i.id, qtyUnits: 10, listTotal: 34.2, lineTotal: 34.2 }], [{ tender: 'cash', amount: 34.2 }])
    const res = await t.as((tx) => applyTillOps(tx, tillId, [
      { type: 'open_run', data: { id: run, tillId, openingFloat: 0, openedAt: new Date() } },
      { type: 'sale', data: bad },
      { type: 'sale', data: good },
      { type: 'sale', data: orphan },
    ], t.userId))
    expect(res.map((r) => r.status)).toEqual(['recorded', 'rejected', 'recorded', 'rejected'])
    expect(res[3].error).toMatch(/unknown till run/)
    const rejects = await t.as((tx) => tx`select error from till_rejects order by id`)
    expect(rejects.map((r) => r.error)).toEqual([expect.stringMatching(/don't add up/), expect.stringMatching(/unknown till run/)])
  })

  it('cannot see another pharmacy\'s sales', async () => {
    const other = await newTenant(db)
    const seen = await other.as((tx) => tx`select count(*)::int as n from sales`)
    expect(seen[0].n).toBe(0)
  })
})
