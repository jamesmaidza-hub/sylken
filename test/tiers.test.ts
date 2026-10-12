import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { createItem } from '../src/domain/items.js'
import { postMovements } from '../src/domain/stock.js'
import { stockTiers, weeklyOrder } from '../src/domain/tiers.js'
import { createApp } from '../src/web/app.js'
import { addUser, appDb, newTenant, webLogin } from './helpers.js'

let db: Sql
let t: Awaited<ReturnType<typeof newTenant>>
beforeAll(async () => { db = appDb(); t = await newTenant(db) })
afterAll(async () => { await db.end() })

const source = { kind: 'imported', label: 'Usage Sep' } as const

describe('stock usage tiers', () => {
  beforeAll(async () => {
    await t.as(async (tx) => {
      // 30 days of imported sales; gross profit 800 + 150 + 40 + 10 = 1000.
      const make = async (code: string, packSize: number, cost: number, schedule: number | undefined, sold: [number, number, number] | null, stock: number) => {
        const it = await createItem(tx, { stockCode: code, description: code, packSize, sellLoose: true, costPerPack: cost, schedule })
        if (stock) await postMovements(tx, [{ itemId: it.id, kind: stock > 0 ? 'opening' : 'sale', qtyUnits: stock }], { allowNegative: true })
        if (sold) await tx`insert into abc_sales_snapshot (tenant_id, item_id, period_from, period_to, qty_units, sales_excl, cost, source)
          values (${t.id}, ${it.id}, '2026-09-01', '2026-09-30', ${sold[0]}, ${sold[1]}, ${sold[2]}, 'Usage Sep')`
      }
      await make('BIG', 1, 10, 1, [60, 1000, 200], 0)      // 2 a day, out of stock
      await make('MID', 1, 5, 0, [30, 300, 150], 5)        // 1 a day, 5 days of cover: low
      await make('SMALL', 1, 3, 2, [3, 60, 20], -2)        // negative
      await make('SLOW', 100, 50, 1, [20, 30, 20], 0)      // a pack of 100 lasts about 5 months
      await make('NONE', 1, 1, 0, null, 10)
    })
  })

  it('cuts tiers by share of profit and flags stock that has run out', async () => {
    const res = await t.as((tx) => stockTiers(tx, { source }))
    expect(res.days).toBe(30)
    expect(res.rows.map((r) => [r.stockCode, r.tier])).toEqual([['BIG', 'A'], ['MID', 'B'], ['SMALL', 'C'], ['SLOW', 'C'], ['NONE', '-']])
    expect(res.shares).toEqual({ A: 80, B: 15, C: 5 })
    const by = Object.fromEntries(res.rows.map((r) => [r.stockCode, r]))
    expect(by.BIG.flag).toBe('out')
    expect(by.MID).toMatchObject({ flag: 'low', coverDays: 5 })
    expect(by.SMALL.flag).toBe('negative')
    expect(by.SLOW).toMatchObject({ flag: 'out', coverDays: 0, perMonthPacks: 0.203 })
    expect(by.BIG.perMonthPacks).toBeCloseTo(60.88, 2)
    expect(res.flags).toEqual({ out: 2, negative: 1, low: 1 })

    // Dispensary only (schedule 1 and up): tiers are cut again within the group.
    const rx = await t.as((tx) => stockTiers(tx, { source, group: 'rx' }))
    expect(rx.rows.map((r) => [r.stockCode, r.tier])).toEqual([['BIG', 'A'], ['SMALL', 'B'], ['SLOW', 'C']])
  })

  it('builds a weekly order inside the budget, tier A first, and sets slow big packs aside', async () => {
    const res = await t.as((tx) => stockTiers(tx, { source }))
    const o = weeklyOrder(res.rows, res.days, { budget: 300, weeks: 2, tiers: ['A', 'B', 'C'] })
    expect(o.lines.map((l) => [l.row.stockCode, l.orderPacks, l.lineCost, l.pick, l.runningTotal])).toEqual([
      ['BIG', 28, 280, true, 280],
      ['MID', 9, 45, false, 280],       // 280 + 45 is over 300
      ['SMALL', 2, 6, true, 286],       // a smaller line still fits
      ['SLOW', 1, 50, false, 286],
    ])
    expect(o.lines[1].note).toBe('Over budget')
    expect(o.lines[2].note).toBe('Negative stock - count first')
    expect(o.lines[3]).toMatchObject({ aside: true, note: '1 pack lasts about 5 months - order per script' })
    expect(o).toMatchObject({ spent: 286, picked: 2, overBudget: 1 })

    expect(weeklyOrder(res.rows, res.days, { budget: 300, weeks: 2, tiers: ['A'] }).lines.map((l) => l.row.stockCode)).toEqual(['BIG'])

    // The person's own ticks and pack counts win over the budget.
    const mine = weeklyOrder(res.rows, res.days, { budget: 300, weeks: 2, tiers: ['A', 'B', 'C'] }, { on: new Set([o.lines[1].row.itemId]), packs: new Map([[o.lines[1].row.itemId, 4]]) })
    expect(mine).toMatchObject({ spent: 20, picked: 1 })
  })

  it('shows the screens and downloads to managers, and not to cashiers', async () => {
    const app = createApp(db)
    const cookie = await webLogin(app, t.email, t.password)
    const get = (p: string, ck = cookie) => app.request(p, { headers: { cookie: ck } })
    const tiers = await (await get('/reports/tiers?source=Usage%20Sep')).text()
    expect(tiers).toContain('Stock usage tiers')
    expect(tiers).toContain('BIG')
    expect(tiers).toContain('Out of stock')
    const order = await (await get('/reports/tiers/order?source=Usage%20Sep&tiers=ABC&budget=300')).text()
    expect(order).toContain('order per script')
    expect(order).toContain('P286.00')
    const xlsx = await get('/reports/tiers/order?source=Usage%20Sep&tiers=ABC&budget=300&format=xlsx')
    expect(xlsx.headers.get('content-type')).toMatch(/spreadsheetml/)
    expect((await get('/reports/tiers?source=Usage%20Sep&format=csv')).status).toBe(200)

    const cashier = await addUser(db, t.id, ['assistant'])
    const ck = await webLogin(app, cashier.email, cashier.password)
    expect((await get('/reports/tiers', ck)).status).toBe(403)
    expect((await get('/reports/tiers/order', ck)).status).toBe(403)
  })
})
