import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { createItem } from '../src/domain/items.js'
import { jitLevels, salesVelocity, weekStats } from '../src/domain/velocity.js'
import { createApp } from '../src/web/app.js'
import { appDb, newTenant, webLogin } from './helpers.js'

describe('weekly sales statistics', () => {
  it('flags a zero week as an empty shelf only for an item that usually sells', () => {
    const s = weekStats([10, 12, 0, 11, 9, 10, 12, 0])
    expect(s.emptyWeeks).toEqual([2, 7])
    expect(s.lostPacks).toBe(21.3)                                 // 2 weeks at the usual 10.67 a week
    expect(s.weeksSold).toBe(6)
    expect(weekStats([1, 0, 0, 1, 0, 0, 1, 0]).emptyWeeks).toEqual([])   // a slow item's quiet week is normal
  })
  it('reads the trend from the second half against the first', () => {
    expect(weekStats([4, 4, 4, 4, 8, 8, 8, 8])).toMatchObject({ trend: 'rising', trendPct: 100 })
    expect(weekStats([8, 8, 8, 8, 4, 4, 4, 4])).toMatchObject({ trend: 'falling', trendPct: -50 })
    expect(weekStats([5, 6, 5, 6, 6, 5, 6, 5]).trend).toBe('flat')
    expect(weekStats([1, 0, 0, 1]).trend).toBe('-')                      // too little to say
  })
  it('measures swing and per-day rate', () => {
    const steady = weekStats([7, 7, 7, 7])
    expect(steady).toMatchObject({ perDay: 1, perWeek: 7, swing: 0 })
    expect(weekStats([0, 14, 0, 14]).swing).toBeGreaterThan(1)
  })
})

describe('just-in-time levels', () => {
  it('holds a few days for A, adding safety stock for swing', () => {
    expect(jitLevels('A', { perDay: 1, weeklySd: 0 }, 56)).toEqual({ min: 2, max: 4, onRequest: false })
    const swingy = jitLevels('A', { perDay: 1, weeklySd: 7 }, 56)
    expect(swingy.min).toBeGreaterThan(2)
    expect(swingy.max).toBeGreaterThan(swingy.min)
  })
  it('orders slow C items only on request', () => {
    expect(jitLevels('C', { perDay: 0.02, weeklySd: 0.3 }, 1)).toEqual({ min: 0, max: 0, onRequest: true })
    expect(jitLevels('C', { perDay: 0.1, weeklySd: 0.3 }, 6).onRequest).toBe(false)
  })
})

// ---------------------------------------------------------------- importing weekly reports through the screen

let db: Sql
beforeAll(() => { db = appDb() })
afterAll(async () => { await db.end() })

/** A weekly Stock Usage report shaped like Compharm's (made-up items, not shop data). */
async function usageReport(from: string, to: string, lines: [code: string, units: number, excl: number, cost: number][]) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  for (const b of ['SAMPLE PHARMACY', 'SHOP 1, SOME MALL', 'GABORONE', 'TEL: 000 0000', 'Report Date: 16 Oct 2026 14:56:23', `Usage from ${from} 00:00:00 to ${to} 23:59:59`]) ws.addRow([b])
  ws.addRow([])
  ws.addRow(['Stock Code', 'Description', 'Units', 'Total Excl', 'Total Cost'])
  for (const l of lines) ws.addRow([l[0], `ITEM ${l[0]}`, l[1], l[2], l[3]])
  return new Blob([await wb.xlsx.writeBuffer()])
}

describe('velocity screen', () => {
  it('imports weekly reports and shows velocity, empty weeks and an order', async () => {
    const t = await newTenant(db)
    await t.as(async (tx) => {
      await createItem(tx, { stockCode: 'FAST', description: 'FAST SELLER', packSize: 1, costPerPack: 10 })
      await createItem(tx, { stockCode: 'SLOW', description: 'SLOW SELLER', packSize: 1, costPerPack: 5 })
    })
    const app = createApp(db)
    const cookie = await webLogin(app, t.email, t.password)

    const weeks: [string, string, number][] = [['01/09/2026', '07/09/2026', 14], ['08/09/2026', '14/09/2026', 0], ['15/09/2026', '21/09/2026', 14], ['22/09/2026', '28/09/2026', 14]]
    const form = new FormData()
    for (const [f, to, fast] of weeks) {
      form.append('file', await usageReport(f, to, [['FAST', fast, fast * 20, fast * 10], ['SLOW', 1, 8, 5], ['GONE', 3, 30, 15]]), 'usage.xlsx')
    }
    const res = await app.request('/items/velocity/import', { method: 'POST', headers: { cookie }, body: form })
    expect(new URL(res.headers.get('location')!, 'http://x').searchParams.get('ok')).toMatch(/^Imported 4 weeks/)

    const v = await t.as((tx) => salesVelocity(tx, { source: 'Compharm weekly' }))
    expect(v.weeks.map((w) => w.to)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'])
    const fast = v.rows.find((r) => r.stockCode === 'FAST')!
    expect(fast).toMatchObject({ rank: 1, cls: 'A', weeks: [14, 0, 14, 14], emptyWeeks: [1], perDay: 1.5, status: 'out' })
    expect(fast.orderPacks).toBe(fast.max)
    expect(v.rows.find((r) => r.stockCode === 'SLOW')).toMatchObject({ cls: 'C', weeksSold: 4 })      // 2 items: top 20% is 1 item, next 30% rounds to none
    expect(v.rows.find((r) => r.stockCode === 'GONE')).toBeUndefined()      // not an item in sylken

    const page = await (await app.request('/items/velocity', { headers: { cookie } })).text()
    expect(page).toContain('FAST SELLER')
    expect(page).toContain('Empty-shelf weeks 1')
    const csv = await (await app.request('/items/velocity?format=csv', { headers: { cookie } })).text()
    expect(csv.split('\n')[0]).toContain('Week to 2026-09-28')

    // A monthly report is imported but not counted as a week.
    const month = new FormData()
    month.append('file', await usageReport('01/08/2026', '31/08/2026', [['FAST', 50, 1000, 500]]), 'month.xlsx')
    const m = await app.request('/items/velocity/import', { method: 'POST', headers: { cookie }, body: month })
    expect(new URL(m.headers.get('location')!, 'http://x').searchParams.get('err')).toMatch(/don't cover 7 days: 2026-08-01 to 2026-08-31/)
  })
})
