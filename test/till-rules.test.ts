import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { hashPassword } from '../src/domain/auth.js'
import { approvalNeeded, basketTotals, cashChange, countTotal, discountPct, priceLine, withinDiscount } from '../src/domain/basket.js'
import { createItem, updateItem } from '../src/domain/items.js'
import { updateSettings } from '../src/domain/settings.js'
import { postMovements } from '../src/domain/stock.js'
import {
  applyTillOps, cashDropDue, closeRun, createTill, getZReport, grantApproval, openRun, openRunOnTill, recordSale, recordTillEntry, recordTillEvent,
  runSummary, saleForRefund, type SaleInput,
} from '../src/domain/till.js'
import { addUser, adminDb, appDb, approvalFor, newTenant, TEST_PIN } from './helpers.js'

// The till operating rules james set on 2026-10-11, one describe block per section. All data is made up.

let db: Sql
let admin: Sql
let t: Awaited<ReturnType<typeof newTenant>>
let cashier: Awaited<ReturnType<typeof addUser>>
let supervisor: Awaited<ReturnType<typeof addUser>>

beforeAll(async () => {
  db = appDb()
  admin = adminDb()
  t = await newTenant(db)
  cashier = await addUser(db, t.id, ['assistant'], 'Fake Cashier')
  supervisor = await addUser(db, t.id, ['supervisor'], 'Fake Supervisor')
  const pin = await hashPassword(TEST_PIN)
  await t.as((tx) => tx`update users set second_pin_hash = ${pin} where id = ${supervisor.id}`)
})
afterAll(async () => { await db.end(); await admin.end() })

const newTill = () => t.as((tx) => createTill(tx, { code: `R${randomUUID().slice(0, 6)}`, name: 'Rules till' }))

const item = (code: string, extra: Record<string, unknown> = {}) =>
  t.as(async (tx) => {
    const i = await createItem(tx, { stockCode: `${code}-${randomUUID().slice(0, 4)}`, description: `Fake item ${code}`, packSize: 10, costPerPack: 20, ...extra })  // retail 34.20 a pack
    await postMovements(tx, [{ itemId: i.id, kind: 'opening', qtyUnits: 1000 }])
    return i
  })

/** A till with a run open on it, opened by the fake cashier's code. */
async function shift(float = 200) {
  const tillId = await newTill()
  const runId = randomUUID()
  await t.as((tx) => openRun(tx, { id: runId, tillId, openingFloat: float, openedAt: new Date(), cashierCode: cashier.staffCode }, t.userId))
  return { tillId, runId }
}

const sale = (runId: string, lines: SaleInput['lines'], payments: SaleInput['payments'], extra: Partial<SaleInput> = {}): SaleInput => ({
  id: randomUUID(), runId, kind: 'sale', occurredAt: new Date(), lines, payments, cashierCode: cashier.staffCode, ...extra,
})
const pack = (itemId: string, packs = 1) => ({ itemId, qtyUnits: 10 * packs, listTotal: 34.2 * packs, lineTotal: 34.2 * packs })

describe('1. shift start and session', () => {
  it('opens blind: the till is not sent the float the last run left', async () => {
    const { tillId, runId } = await shift(150)
    await t.as((tx) => closeRun(tx, runId, { counted: { cash: 150, card: 0, cheque: 0 }, floatKept: 120 }))
    const next = randomUUID()
    await t.as((tx) => openRun(tx, { id: next, tillId, openingFloat: 118, openedAt: new Date(), cashierCode: cashier.staffCode }, t.userId))
    const s = (await t.as((tx) => runSummary(tx, next)))!
    expect([s.openingFloat, s.expectedFloat]).toEqual([118, 120])   // what was counted, and (for managers only) what was left
  })

  it('lets a till have only one open run, even straight into the database', async () => {
    const { tillId, runId } = await shift()
    await expect(t.as((tx) => openRun(tx, { id: randomUUID(), tillId, openingFloat: 0, openedAt: new Date() }, t.userId))).rejects.toThrow(/already has run \d+ open/)
    await expect(t.as((tx) => tx`
      insert into till_runs (id, tenant_id, till_id, run_no, opening_float, opened_at, cashier_id)
      values (${randomUUID()}, ${t.id}, ${tillId}, 999999, 0, now(), ${t.userId})`)).rejects.toThrow(/already has run/)
    expect((await t.as((tx) => openRunOnTill(tx, tillId)))!.id).toBe(runId)
  })

  it('anchors each run to its cashier, its till and its own id, number and time', async () => {
    const { tillId, runId } = await shift()
    const [r] = await t.as((tx) => tx`select till_id, cashier_id, cashier_code, run_no, opened_at, recorded_at from till_runs where id = ${runId}`)
    expect(r).toMatchObject({ till_id: tillId, cashier_id: cashier.id, cashier_code: cashier.staffCode })
    expect(r.run_no).toBeGreaterThan(0)
    expect(r.opened_at).toBeInstanceOf(Date)
    expect(r.recorded_at).toBeInstanceOf(Date)
  })

  it('refuses a second run opened offline on a till that already has one, and keeps it for the back office', async () => {
    const { tillId } = await shift()
    const res = await t.as((tx) => applyTillOps(tx, tillId, [{ type: 'open_run', data: { id: randomUUID(), tillId, openingFloat: 50, openedAt: new Date() } }], t.userId))
    expect(res[0]).toMatchObject({ status: 'rejected', error: expect.stringMatching(/already has run/) })
  })
})

describe('2. basket and ledger', () => {
  it('works out subtotal, discounts, VAT per rate and the total in one place', () => {
    const a = priceLine({ packPrice: 34.2, packSize: 10, units: 20 })
    const b = priceLine({ packPrice: 75, packSize: 1, units: 2, adjust: { kind: 'discount', pct: 10 } })
    const c = priceLine({ packPrice: 20, packSize: 1, units: 1, adjust: { kind: 'override', packPrice: 15 } })
    expect([a, b, c]).toEqual([{ listTotal: 68.4, lineTotal: 68.4 }, { listTotal: 150, lineTotal: 135 }, { listTotal: 20, lineTotal: 15 }])
    const totals = basketTotals([{ ...a, vatRate: 0.14 }, { ...b, vatRate: 0 }, { ...c, vatRate: 0.14 }])
    expect(totals).toMatchObject({ subtotal: 238.4, discount: 20, total: 218.4, vat: 10.24, promotions: [] })
    expect(totals.vatByRate).toEqual([{ rate: 0.14, gross: 83.4, vat: 10.24, net: 73.16 }, { rate: 0, gross: 135, vat: 0, net: 135 }])
    // Taking a line off moves every figure with it.
    expect(basketTotals([{ ...b, vatRate: 0 }])).toMatchObject({ subtotal: 150, discount: 15, total: 135, vat: 0 })
  })

  it('decides which price changes need a supervisor', () => {
    expect(approvalNeeded({ listTotal: 100, lineTotal: 90, adjust: 'discount' }, 10)).toBeNull()
    expect(approvalNeeded({ listTotal: 0.99, lineTotal: 0.89, adjust: 'discount' }, 10)).toBeNull()     // 10% to the cent
    expect(approvalNeeded({ listTotal: 100, lineTotal: 89.99, adjust: 'discount' }, 10)).toBe('discount')
    expect(approvalNeeded({ listTotal: 100, lineTotal: 100.5, adjust: 'override' }, 10)).toBe('price_override')
    expect(approvalNeeded({ listTotal: -100, lineTotal: -90, adjust: 'discount' }, 10)).toBeNull()
    expect(withinDiscount(100, 75, 25)).toBe(true)
    expect(discountPct(150, 135)).toBe(10)
  })

  it('keeps paid sales, drawer entries, events, counts and Z reports read-only', async () => {
    const i = await item('RO')
    const { tillId, runId } = await shift(0)
    const s = sale(runId, [pack(i.id)], [{ tender: 'cash', amount: 34.2 }])
    await t.as((tx) => recordSale(tx, s))
    await expect(t.as((tx) => tx`update sale_lines set line_total = 1 where sale_id = ${s.id}`)).rejects.toThrow(/never edited/)
    await expect(t.as((tx) => tx`delete from sales where id = ${s.id}`)).rejects.toThrow(/never edited/)
    const drop = randomUUID()
    await t.as(async (tx) => recordTillEntry(tx, { id: drop, runId, kind: 'cash_drop', tender: 'cash', amount: 10, approvalId: await approvalFor(tx, tillId, drop, 'cash_drop', { amount: 10 }), occurredAt: new Date() }))
    await expect(t.as((tx) => tx`update till_entries set amount = 1 where id = ${drop}`)).rejects.toThrow(/never changed/)
    await expect(t.as((tx) => tx`delete from till_approvals`)).rejects.toThrow(/never changed/)
    await t.as((tx) => closeRun(tx, runId, { cash: { '20': 1, '2': 2, '0.1': 2 }, counted: { card: 0, cheque: 0 }, floatKept: 0 }))
    await expect(t.as((tx) => tx`update till_run_counts set counted = 0 where till_run_id = ${runId}`)).rejects.toThrow(/never changed/)
    await expect(t.as((tx) => tx`update z_reports set payload = '{}' where till_run_id = ${runId}`)).rejects.toThrow(/never changed/)
    await expect(t.as((tx) => tx`update till_runs set note = 'changed' where id = ${runId}`)).rejects.toThrow(/locked/)
  })

  it('does not let the app change the shape of the sales tables', async () => {
    await expect(t.as((tx) => tx`alter table sales drop column total`)).rejects.toThrow(/owner|permission/)
    await expect(t.as((tx) => tx`drop trigger sales_immutable on sales`)).rejects.toThrow(/owner|permission/)
  })

  it('corrects a paid sale only with a separate refund that points at it', async () => {
    const i = await item('RF')
    const { tillId, runId } = await shift(500)
    const s = sale(runId, [pack(i.id, 2)], [{ tender: 'cash', amount: 68.4 }])
    await t.as((tx) => recordSale(tx, s))
    const refund = (lines: SaleInput['lines'], extra: Partial<SaleInput> = {}) => sale(runId, lines, [{ tender: 'cash', amount: lines.reduce((a, l) => a + l.lineTotal, 0) }], { kind: 'refund', refundOf: s.id, ...extra })
    const back = { itemId: i.id, qtyUnits: -10, listTotal: -34.2, lineTotal: -34.2 }

    await expect(t.as((tx) => recordSale(tx, refund([back], { refundOf: null })))).rejects.toThrow(/which sale it reverses/)
    await expect(t.as((tx) => recordSale(tx, refund([back])))).rejects.toThrow(/refund needs a supervisor/)
    const tooMany = refund([{ ...back, qtyUnits: -30, listTotal: -102.6, lineTotal: -102.6 }])
    tooMany.refundApprovalId = await t.as((tx) => approvalFor(tx, tillId, tooMany.id, 'refund', { total: 102.6 }))
    await expect(t.as((tx) => recordSale(tx, tooMany))).rejects.toThrow(/more of an item/)
    const greedy = refund([{ ...back, listTotal: -50, lineTotal: -50 }])
    greedy.refundApprovalId = await t.as((tx) => approvalFor(tx, tillId, greedy.id, 'refund', { total: 50 }))
    await expect(t.as((tx) => recordSale(tx, greedy))).rejects.toThrow(/more money/)
    const small = refund([back])
    small.refundApprovalId = await t.as((tx) => approvalFor(tx, tillId, small.id, 'refund', { total: 10 }))
    await expect(t.as((tx) => recordSale(tx, small))).rejects.toThrow(/allowed a refund of P10.00/)

    const ok = refund([back])
    ok.refundApprovalId = await t.as((tx) => approvalFor(tx, tillId, ok.id, 'refund', { total: 34.2 }))
    await t.as((tx) => recordSale(tx, ok))
    const [row] = await t.as((tx) => tx`select refund_of, refund_approval_id from sales where id = ${ok.id}`)
    expect(row).toEqual({ refund_of: s.id, refund_approval_id: ok.refundApprovalId })
    const left = (await t.as(async (tx) => saleForRefund(tx, String((await tx`select sale_no from sales where id = ${s.id}`)[0].sale_no))))!
    expect(left.lines[0]).toMatchObject({ unitsLeft: 10, amountLeft: 34.2 })
    expect((await t.as((tx) => saleForRefund(tx, left.ref)))!.id).toBe(s.id)
  })

  it('will not finish a sale with something to pay and nothing paid', async () => {
    const i = await item('ZERO')
    const { runId } = await shift()
    await expect(t.as((tx) => recordSale(tx, sale(runId, [pack(i.id)], [])))).rejects.toThrow(/nothing has been paid/)
  })
})

describe('3. payments and change', () => {
  it('works out change and refuses more change than the shop allows', async () => {
    expect(cashChange(50, 34.2, 200)).toEqual({ change: 15.8, tooMuch: false })
    expect(cashChange(1000, 10, 200).tooMuch).toBe(true)
    const i = await item('CHG')
    const { runId } = await shift()
    await expect(t.as((tx) => recordSale(tx, sale(runId, [pack(i.id)], [{ tender: 'cash', amount: 34.2 }], { cashTendered: 1034.2 })))).rejects.toThrow(/more than the P200.00/)
    await t.as((tx) => recordSale(tx, sale(runId, [pack(i.id)], [{ tender: 'cash', amount: 34.2 }], { cashTendered: 200 })))
  })

  it('takes split payments that together settle the sale', async () => {
    const i = await item('SPLIT')
    const { runId } = await shift()
    const s = sale(runId, [pack(i.id, 3)], [{ tender: 'card', amount: 50, reference: 'AUTH01' }, { tender: 'cash', amount: 52.6 }], { cashTendered: 60 })
    await t.as((tx) => recordSale(tx, s))
    await expect(t.as((tx) => recordSale(tx, sale(runId, [pack(i.id, 3)], [{ tender: 'card', amount: 50, reference: 'AUTH02' }])))).rejects.toThrow(/don't add up/)
  })

  it('counts a card payment only with the machine\'s approval code, or a gateway token once a terminal is linked', async () => {
    const t2 = await newTenant(db)
    const tillId = await t2.as((tx) => createTill(tx, { code: 'CARD', name: 'Card till' }))
    const runId = randomUUID()
    const i = await t2.as(async (tx) => {
      await openRun(tx, { id: runId, tillId, openingFloat: 0, openedAt: new Date() }, t2.userId)
      return createItem(tx, { stockCode: 'C1', description: 'Fake card item', packSize: 1, costPerPack: 10, retailPerPack: 20 })
    })
    const card = (p: Record<string, unknown>) => sale(runId, [{ itemId: i.id, qtyUnits: 1, listTotal: 20, lineTotal: 20 }], [{ tender: 'card', amount: 20, ...p }])
    await expect(t2.as((tx) => recordSale(tx, card({})))).rejects.toThrow(/approval code/)
    await t2.as((tx) => recordSale(tx, card({ reference: '123456' })))
    await t2.as((tx) => updateSettings(tx, { cardTerminal: 'integrated' }))
    await expect(t2.as((tx) => recordSale(tx, card({ reference: '123456' })))).rejects.toThrow(/transaction token/)
    const s = card({ gatewayToken: 'tok_FAKE_0001', gatewayPayload: { terminal: 'fake', approved: true } })
    await t2.as((tx) => recordSale(tx, s))
    const [p] = await t2.as((tx) => tx`select gateway_token, gateway_payload from sale_payments where sale_id = ${s.id}`)
    expect(p).toEqual({ gateway_token: 'tok_FAKE_0001', gateway_payload: { terminal: 'fake', approved: true } })
  })
})

describe('4. drawer and loss prevention', () => {
  it('logs a no-sale only with a reason and a supervisor, as high priority, in the audit log too', async () => {
    const { tillId, runId } = await shift()
    const id = randomUUID()
    const ev = (extra: Record<string, unknown> = {}) => ({ id, runId, kind: 'no_sale' as const, reason: 'Change for a customer', cashierCode: cashier.staffCode, occurredAt: new Date(), ...extra })
    await expect(t.as((tx) => recordTillEvent(tx, ev({ reason: '' })))).rejects.toThrow(/needs a reason/)
    await expect(t.as((tx) => recordTillEvent(tx, ev()))).rejects.toThrow(/needs a supervisor/)
    const approvalId = await t.as((tx) => approvalFor(tx, tillId, id, 'no_sale', { reason: 'Change for a customer' }))
    await t.as((tx) => recordTillEvent(tx, ev({ approvalId })))
    const [row] = await t.as((tx) => tx`select priority, reason, approval_id from till_events where id = ${id}`)
    expect(row).toEqual({ priority: 'high', reason: 'Change for a customer', approval_id: approvalId })
    const [log] = await t.as((tx) => tx`select detail from audit_log where action = 'till.no_sale' and entity_id = ${id}`)
    expect(log.detail).toMatchObject({ priority: 'high', reason: 'Change for a customer' })
    expect((await t.as((tx) => runSummary(tx, runId)))!.events.noSales).toBe(1)
  })

  it('logs voids, high priority when a supervisor had to allow them', async () => {
    const { tillId, runId } = await shift()
    const saleId = randomUUID()
    await t.as((tx) => recordTillEvent(tx, { id: randomUUID(), runId, kind: 'void', detail: { saleId, description: 'Fake', units: 1, lineTotal: 3.42 }, occurredAt: new Date() }))
    const approvalId = await t.as((tx) => approvalFor(tx, tillId, saleId, 'void', { units: 10 }))
    await t.as((tx) => recordTillEvent(tx, { id: randomUUID(), runId, kind: 'void', detail: { saleId, description: 'Fake', units: 10, lineTotal: 34.2 }, approvalId, occurredAt: new Date() }))
    await expect(t.as((tx) => recordTillEvent(tx, { id: randomUUID(), runId, kind: 'void', detail: { saleId: randomUUID() }, approvalId, occurredAt: new Date() }))).rejects.toThrow(/no such approval/)
    const rows = await t.as((tx) => tx`select priority from till_events where till_run_id = ${runId} order by recorded_at, priority`)
    expect(rows.map((r) => r.priority).sort()).toEqual(['high', 'normal'])
    expect((await t.as((tx) => runSummary(tx, runId)))!.events).toMatchObject({ voids: 2, voidTotal: 37.62 })
  })

  it('asks for a cash drop past the threshold without telling the till how much is in the drawer', async () => {
    await t.as((tx) => updateSettings(tx, { cashDropThreshold: 300 }))
    const i = await item('DROP')
    const { tillId, runId } = await shift(200)
    await t.as((tx) => recordSale(tx, sale(runId, [pack(i.id, 3)], [{ tender: 'cash', amount: 102.6 }])))
    expect(await t.as((tx) => cashDropDue(tx, runId))).toBe(true)                     // 302.60 in the drawer
    const drop = randomUUID()
    await expect(t.as((tx) => recordTillEntry(tx, { id: drop, runId, kind: 'cash_drop', tender: 'cash', amount: 100, occurredAt: new Date() }))).rejects.toThrow(/needs a supervisor/)
    await t.as(async (tx) => recordTillEntry(tx, { id: drop, runId, kind: 'cash_drop', tender: 'cash', amount: 100, approvalId: await approvalFor(tx, tillId, drop, 'cash_drop', { amount: 100 }), occurredAt: new Date() }))
    expect(await t.as((tx) => cashDropDue(tx, runId))).toBe(false)
    await t.as((tx) => updateSettings(tx, { cashDropThreshold: 2000 }))
  })

  it('needs a supervisor for petty cash, a cash payout', async () => {
    const { tillId, runId } = await shift()
    const id = randomUUID()
    const entry = { id, runId, kind: 'petty_cash' as const, tender: 'cash' as const, amount: 30, note: 'Fake milk', occurredAt: new Date() }
    await expect(t.as((tx) => recordTillEntry(tx, entry))).rejects.toThrow(/needs a supervisor/)
    const small = await t.as((tx) => approvalFor(tx, tillId, id, 'petty_cash', { amount: 20 }))
    await expect(t.as((tx) => recordTillEntry(tx, { ...entry, approvalId: small }))).rejects.toThrow(/allowed P20.00/)
  })
})

describe('5. cash-up and Z report', () => {
  it('takes the count in notes and coins, logs the variance by the formula, makes a Z report and locks the run', async () => {
    const i = await item('Z')
    const { tillId, runId } = await shift(200)
    await t.as((tx) => recordSale(tx, sale(runId, [pack(i.id, 5)], [{ tender: 'cash', amount: 171 }])))
    await t.as((tx) => recordSale(tx, sale(runId, [pack(i.id)], [{ tender: 'card', amount: 34.2, reference: 'AUTH99' }])))
    const drop = randomUUID()
    const petty = randomUUID()
    await t.as(async (tx) => {
      await recordTillEntry(tx, { id: drop, runId, kind: 'cash_drop', tender: 'cash', amount: 150, approvalId: await approvalFor(tx, tillId, drop, 'cash_drop', { amount: 150 }), occurredAt: new Date() })
      await recordTillEntry(tx, { id: petty, runId, kind: 'petty_cash', tender: 'cash', amount: 11, note: 'Fake stamps', approvalId: await approvalFor(tx, tillId, petty, 'petty_cash', { amount: 11 }), occurredAt: new Date() })
    })
    // Expected cash = 200 float + (171 - 11) net cash - 150 dropped = 210. Counted: 1 x 200 + 1 x 5 + 2 x 2 = 209, so P1 short.
    const count = { '200': 1, '5': 1, '2': 2 }
    expect(countTotal(count)).toBe(209)
    await expect(t.as((tx) => closeRun(tx, runId, { cash: { '3': 1 }, counted: { card: 0, cheque: 0 }, floatKept: 0 }))).rejects.toThrow(/not a Botswana note/)
    const s = await t.as((tx) => closeRun(tx, runId, { cash: count, counted: { card: 34.2, cheque: 0 }, floatKept: 200 }))
    expect(s.expected.cash).toBe(210)
    expect(s.counts.find((c) => c.tender === 'cash')).toMatchObject({ expected: 210, counted: 209, surplus: -1 })
    expect(s.cashCount).toEqual([{ denomination: 200, qty: 1 }, { denomination: 5, qty: 1 }, { denomination: 2, qty: 2 }])
    const [v] = await t.as((tx) => tx`select variance from till_run_counts where till_run_id = ${runId} and tender = 'cash'`)
    expect(Number(v.variance)).toBe(-1)

    const z = (await t.as((tx) => getZReport(tx, runId)))!
    expect(z.zNo).toBeGreaterThan(0)
    expect(z.exportStatus).toBe('no_target')                                           // nothing linked to send it to yet
    expect(z.payload).toMatchObject({
      sales: { count: 2, net: 205.2 }, cash: { openingFloat: 200, netCash: 160, cashDrops: 150, expected: 210, counted: 209, variance: -1, floatKept: 200 },
      tenders: { cash: 171, card: 34.2 },
    })
    expect(z.payload.vatByRate).toEqual([{ rate: 0.14, gross: 205.2, vat: 25.2, net: 180 }])
    await expect(t.as((tx) => closeRun(tx, runId, { cash: count, counted: { card: 0, cheque: 0 }, floatKept: 0 }))).rejects.toThrow(/already cashed up/)
  })
})

describe('6. supervisor approvals', () => {
  it('lets a cashier give a discount up to the limit alone, and no more without a supervisor', async () => {
    const i = await item('DISC')
    const { tillId, runId } = await shift()
    await t.as((tx) => recordSale(tx, sale(runId, [{ ...pack(i.id), lineTotal: 30.78, adjust: 'discount' }], [{ tender: 'cash', amount: 30.78 }])))   // 10%
    const big = sale(runId, [{ ...pack(i.id), lineTotal: 17.1, adjust: 'discount' }], [{ tender: 'cash', amount: 17.1 }])                            // 50%
    await expect(t.as((tx) => recordSale(tx, big))).rejects.toThrow(/needs a supervisor/)
    const other = await item('OTHER')
    big.lines[0].approvalId = await t.as((tx) => approvalFor(tx, tillId, big.id, 'discount', { itemId: other.id, pct: 50 }))
    await expect(t.as((tx) => recordSale(tx, big))).rejects.toThrow(/does not cover the discount/)
    big.lines[0].approvalId = await t.as((tx) => approvalFor(tx, tillId, big.id, 'discount', { itemId: i.id, pct: 50 }))
    await t.as((tx) => recordSale(tx, big))
    const [l] = await t.as((tx) => tx`select adjust, approval_id from sale_lines where sale_id = ${big.id}`)
    expect(l).toEqual({ adjust: 'discount', approval_id: big.lines[0].approvalId })
  })

  it('needs a supervisor for any price typed in, and a reason for any price that differs', async () => {
    const i = await item('OVR')
    const { tillId, runId } = await shift()
    await expect(t.as((tx) => recordSale(tx, sale(runId, [{ ...pack(i.id), lineTotal: 30 }], [{ tender: 'cash', amount: 30 }])))).rejects.toThrow(/no discount or price change recorded/)
    const s = sale(runId, [{ ...pack(i.id, 2), lineTotal: 60, adjust: 'override' }], [{ tender: 'cash', amount: 60 }])
    await expect(t.as((tx) => recordSale(tx, s))).rejects.toThrow(/needs a supervisor/)
    s.lines[0].approvalId = await t.as((tx) => approvalFor(tx, tillId, s.id, 'price_override', { itemId: i.id, packPrice: 25 }))
    await expect(t.as((tx) => recordSale(tx, s))).rejects.toThrow(/does not cover the price/)
    s.lines[0].approvalId = await t.as((tx) => approvalFor(tx, tillId, s.id, 'price_override', { itemId: i.id, packPrice: 30 }))
    await t.as((tx) => recordSale(tx, s))
  })

  it('flags a list price the item does not have, without losing the sale', async () => {
    const i = await item('MISM')
    const { runId } = await shift()
    const s = sale(runId, [{ itemId: i.id, qtyUnits: 10, listTotal: 20, lineTotal: 20 }], [{ tender: 'cash', amount: 20 }])
    await t.as((tx) => recordSale(tx, s))
    const [e] = await t.as((tx) => tx`select kind, priority, detail from till_events where till_run_id = ${runId}`)
    expect(e).toMatchObject({ kind: 'price_mismatch', priority: 'high', detail: { saleId: s.id, listTotal: 20, priceNow: 34.2 } })
    // A price that changed in the last day is not a mismatch: the till's list can be a little behind.
    await t.as((tx) => updateItem(tx, i.id, { retailPerPack: 40 }, t.userId))
    await t.as((tx) => recordSale(tx, sale(runId, [pack(i.id)], [{ tender: 'cash', amount: 34.2 }])))
    expect((await t.as((tx) => tx`select count(*)::int as n from till_events where till_run_id = ${runId}`))[0].n).toBe(1)
  })

  it('takes a supervisor\'s code and second PIN, not a cashier\'s, and locks after too many wrong PINs', async () => {
    const tillId = await newTill()
    const ask = (code: string, pin: string) => t.as((tx) => grantApproval(tx, { tillId, subjectId: randomUUID(), action: 'no_sale', staffCode: code, pin, detail: { reason: 'test' } }))
    const ok = await ask(supervisor.staffCode, TEST_PIN)
    expect(ok).toMatchObject({ id: expect.any(String), name: 'Fake Supervisor', code: supervisor.staffCode })
    expect(await ask(cashier.staffCode, TEST_PIN)).toBeNull()                         // a cashier has no PIN and no say
    expect(await ask('QQ', TEST_PIN)).toBeNull()
    for (let n = 0; n < 5; n++) expect(await ask(supervisor.staffCode, '000000')).toBeNull()
    expect(await ask(supervisor.staffCode, TEST_PIN)).toBeNull()                      // locked now, even with the right PIN
    const [u] = await t.as((tx) => tx`select locked_until from users where id = ${supervisor.id}`)
    expect(u.locked_until.getTime()).toBeGreaterThan(Date.now())
    const log = await t.as((tx) => tx`select action from audit_log where user_id = ${supervisor.id} and action like 'till_pin%' or (user_id = ${supervisor.id} and action = 'locked')`)
    expect(log.map((l) => l.action)).toContain('locked')
    await t.as((tx) => tx`update users set locked_until = null, failed_logins = 0 where id = ${supervisor.id}`)
  })
})
