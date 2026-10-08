import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { createItem, getItem, updateItem } from '../src/domain/items.js'
import { applyMinMaxSuggestions, minMaxOrderReport, setMinMax, suggestMinMax } from '../src/domain/minmax.js'
import { addInvoiceLine, createInvoice, createSupplier, getInvoice, postInvoice } from '../src/domain/receiving.js'
import { updateSettings } from '../src/domain/settings.js'
import { adjustStock, postMovements } from '../src/domain/stock.js'
import { postStockTake, recordCount, startStockTake, stockTakeSummary } from '../src/domain/stocktake.js'
import { purgeTenant } from '../src/domain/tenants.js'
import { adminDb, appDb, newTenant } from './helpers.js'

let db: Sql
let admin: Sql
let t: Awaited<ReturnType<typeof newTenant>>

beforeAll(async () => {
  db = appDb()
  admin = adminDb()
  t = await newTenant(db)
})
afterAll(async () => { await db.end(); await admin.end() })

const item = (code: string, extra: Record<string, unknown> = {}) =>
  t.as((tx) => createItem(tx, { stockCode: code, description: `Item ${code}`, packSize: 10, costPerPack: 20, ...extra }))

describe('item master', () => {
  it('prices a new item from cost with the shop rule and registers its barcode', async () => {
    const i = await item('6005894000352')
    expect(i.retailPerPack).toBe(34.2)            // 20 x 1.5 x 1.14
    expect(i.barcodes).toEqual(['6005894000352'])
    const dup = item('6005894000352')
    await expect(dup).rejects.toThrow(/already exists/)
  })

  it('rejects impossible costs', async () => {
    await expect(item('BIG', { costPerPack: 13_387_138.67 })).rejects.toThrow(/outside the allowed range/)
  })

  it('refuses to change pack size while stock is held', async () => {
    const i = await item('PACK1')
    await t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'opening', qtyUnits: 5 }]))
    await expect(t.as((tx) => updateItem(tx, i.id, { packSize: 20 }))).rejects.toThrow(/pack size/)
  })
})

describe('stock ledger', () => {
  it('keeps on-hand in step with movements and ignores re-sent ids', async () => {
    const i = await item('LEDGER1')
    const id = randomUUID()
    await t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'opening', qtyUnits: 30 }]))
    const first = await t.as((tx) => postMovements(tx, [{ id, itemId: i.id, kind: 'sale', qtyUnits: -4 }]))
    const again = await t.as((tx) => postMovements(tx, [{ id, itemId: i.id, kind: 'sale', qtyUnits: -4 }]))
    expect(first).toHaveLength(1)
    expect(again).toHaveLength(0)
    expect((await t.as((tx) => getItem(tx, i.id)))!.onHandUnits).toBe(26)
  })

  it('blocks selling stock that is not there unless overridden or allowed', async () => {
    const i = await item('NEG1')
    await expect(t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'sale', qtyUnits: -1 }]))).rejects.toThrow(/only 0 units/)
    await t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'sale', qtyUnits: -1 }], { allowNegative: true }))
    await t.as((tx) => updateSettings(tx, { allowNegativeStock: true }))
    await t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'sale', qtyUnits: -1 }]))
    await t.as((tx) => updateSettings(tx, { allowNegativeStock: false }))
    expect((await t.as((tx) => getItem(tx, i.id)))!.onHandUnits).toBe(-2)
  })

  it('blocks selling a quarantined item', async () => {
    const i = await item('QUAR1', { status: 'quarantined' })
    await t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'opening', qtyUnits: 5 }]))
    await expect(t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'sale', qtyUnits: -1 }]))).rejects.toThrow(/quarantined/)
  })

  it('never lets a movement be edited or deleted', async () => {
    const i = await item('IMMUT1')
    const [id] = await t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'opening', qtyUnits: 5 }]))
    await expect(t.as((tx) => tx`update stock_movements set qty_units = 50 where id = ${id}`)).rejects.toThrow(/append-only/)
    await expect(t.as((tx) => tx`delete from stock_movements where id = ${id}`)).rejects.toThrow(/append-only/)
  })

  it('records adjustments with a reason at average cost', async () => {
    const i = await item('ADJ1')
    await t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'opening', qtyUnits: 10 }]))
    await t.as((tx) => adjustStock(tx, { itemId: i.id, qtyUnits: -3, reasonCode: 'DAMAGED', note: 'dropped' }))
    await expect(t.as((tx) => adjustStock(tx, { itemId: i.id, qtyUnits: -1, reasonCode: 'NOPE' }))).rejects.toThrow(/reason/)
    const [m] = await t.as((tx) => tx`select unit_cost, reason_code from stock_movements where item_id = ${i.id} and kind = 'adjustment'`)
    expect(Number(m.unit_cost)).toBe(2)
    expect(m.reason_code).toBe('DAMAGED')
  })
})

describe('receiving', () => {
  it('posts an invoice: stock up, last and average cost, re-priced retail, bonus stock free', async () => {
    const i = await item('RCV1')
    await t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'opening', qtyUnits: 10, unitCost: 2 }]))
    const sup = await t.as((tx) => createSupplier(tx, { name: 'Medswana' }))
    const inv = await t.as((tx) => createInvoice(tx, { supplierId: sup, invoiceNo: 'INV-1', invoiceDate: '2026-10-08' }))
    await t.as((tx) => addInvoiceLine(tx, inv, { itemId: i.id, qtyPacks: 2, bonusPacks: 1, costPerPack: 30 }))
    const draft = await t.as((tx) => getInvoice(tx, inv))
    expect(draft!.totalExcl).toBe(60)
    expect(draft!.totalIncl).toBeCloseTo(68.4)
    await t.as((tx) => postInvoice(tx, inv))
    const after = (await t.as((tx) => getItem(tx, i.id)))!
    expect(after.onHandUnits).toBe(40)                // 10 + 3 packs of 10
    expect(after.costPerPack).toBe(30)
    expect(after.avgCostPerPack).toBe(20)             // 1 pack at 20 + 3 packs at 20 effective (60 / 3)
    expect(after.retailPerPack).toBe(51.3)            // 30 x 1.5 x 1.14
    await expect(t.as((tx) => postInvoice(tx, inv))).rejects.toThrow(/already posted/)
    await expect(t.as((tx) => createInvoice(tx, { supplierId: sup, invoiceNo: 'INV-1', invoiceDate: '2026-10-08' }))).rejects.toThrow(/already captured/)
  })

  it('wakes a dormant item when it is received', async () => {
    const i = await item('DORM1', { status: 'dormant' })
    const sup = await t.as((tx) => createSupplier(tx, { name: 'Medswana' }))
    const inv = await t.as((tx) => createInvoice(tx, { supplierId: sup, invoiceNo: 'INV-2', invoiceDate: '2026-10-08' }))
    await t.as((tx) => addInvoiceLine(tx, inv, { itemId: i.id, qtyPacks: 1, costPerPack: 20, updateRetail: false }))
    await t.as((tx) => postInvoice(tx, inv))
    expect((await t.as((tx) => getItem(tx, i.id)))!.status).toBe('active')
  })
})

describe('stock take', () => {
  it('moves stock by counted minus expected, keeping sales made during the count', async () => {
    const i = await item('ST1')
    await t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'opening', qtyUnits: 50 }]))
    const st = await t.as((tx) => startStockTake(tx, { name: 'Test' }))
    await t.as((tx) => postMovements(tx, [{ itemId: i.id, kind: 'sale', qtyUnits: -5 }]))   // sold after the snapshot
    await t.as((tx) => recordCount(tx, st, i.id, 20, 'add'))
    await t.as((tx) => recordCount(tx, st, i.id, 22, 'add'))                               // second shelf
    const sum = await t.as((tx) => stockTakeSummary(tx, st))
    expect(sum!.lines.find((l) => l.itemId === i.id)!.varianceUnits).toBe(-8)
    await t.as((tx) => postStockTake(tx, st))
    expect((await t.as((tx) => getItem(tx, i.id)))!.onHandUnits).toBe(37)               // 50 - 5 sold - 8 short
    await expect(t.as((tx) => recordCount(tx, st, i.id, 1))).rejects.toThrow(/closed/)
  })
})

describe('min/max', () => {
  it('lists items at or below min, ordering up to max, including zero-quantity lines like Compharm', async () => {
    const low = await item('MM-LOW')
    const equal = await item('MM-EQ')
    const fine = await item('MM-OK')
    await t.as(async (tx) => {
      await postMovements(tx, [
        { itemId: low.id, kind: 'opening', qtyUnits: 5 },
        { itemId: equal.id, kind: 'opening', qtyUnits: 30 },
        { itemId: fine.id, kind: 'opening', qtyUnits: 100 },
      ])
      await setMinMax(tx, low.id, 20, 60)
      await setMinMax(tx, equal.id, 30, 30)
      await setMinMax(tx, fine.id, 20, 60)
    })
    const report = await t.as((tx) => minMaxOrderReport(tx))
    const byCode = new Map(report.map((r) => [r.stockCode, r]))
    expect(byCode.get('MM-LOW')!.orderPacks).toBe(5.5)
    expect(byCode.get('MM-LOW')!.orderPacksWhole).toBe(6)
    expect(byCode.get('MM-EQ')!.orderUnits).toBe(0)
    expect(byCode.has('MM-OK')).toBe(false)
    await expect(t.as((tx) => setMinMax(tx, low.id, 10, 5))).rejects.toThrow(/max must be at least min/)
  })

  it('suggests levels from usage and keeps levels set by hand', async () => {
    const a = await item('MM-USE')
    const b = await item('MM-MANUAL')
    const now = new Date()
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    await t.as(async (tx) => {
      for (const it of [a, b]) {
        await tx`insert into usage_history (tenant_id, item_id, period, sold_units, source)
                 values (current_setting('app.tenant_id')::uuid, ${it.id}, ${lastMonth}, 900, 'test')`
      }
      await setMinMax(tx, b.id, 1, 2, 'manual')
    })
    const sug = (await t.as((tx) => suggestMinMax(tx))).find((s) => s.itemId === a.id)!
    expect(sug.aduUnits).toBeGreaterThan(4)
    expect(sug.suggestedMax).toBeGreaterThan(sug.suggestedMin)
    await t.as((tx) => applyMinMaxSuggestions(tx))
    expect((await t.as((tx) => getItem(tx, a.id)))!.minmaxSource).toBe('calculated')
    const manual = (await t.as((tx) => getItem(tx, b.id)))!
    expect([manual.minUnits, manual.maxUnits, manual.minmaxSource]).toEqual([1, 2, 'manual'])
  })
})

describe('tenants', () => {
  it('cannot see or write another pharmacy\'s data', async () => {
    const other = await newTenant(db)
    const mine = await item('PRIVATE1')
    const seen = await other.as((tx) => tx`select id from items where id = ${mine.id}`)
    expect(seen).toHaveLength(0)
    await expect(other.as((tx) => tx`insert into items (tenant_id, stock_code) values (${t.id}, 'SNEAK')`)).rejects.toThrow(/row-level security/)
    const none = await db`select count(*)::int as n from items`
    expect(none[0].n).toBe(0)                           // no tenant set: nothing visible
  })

  it('purges a whole tenant, ledger included', async () => {
    const gone = await newTenant(db)
    await gone.as(async (tx) => {
      const i = await createItem(tx, { stockCode: 'X', description: 'X', costPerPack: 1 })
      await postMovements(tx, [{ itemId: i.id, kind: 'opening', qtyUnits: 1 }])
    })
    await purgeTenant(admin, gone.id)
    const [r] = await admin`select count(*)::int as n from stock_movements where tenant_id = ${gone.id}`
    expect(r.n).toBe(0)
  })
})
