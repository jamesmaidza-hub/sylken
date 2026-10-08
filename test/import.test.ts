import ExcelJS from 'exceljs'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { findByCode } from '../src/domain/items.js'
import { minMaxOrderReport } from '../src/domain/minmax.js'
import { compareMinMax } from '../src/import/check.js'
import { importCompharm, readCompharmMinMax } from '../src/import/compharm.js'
import { appDb, newTenant } from './helpers.js'

let db: Sql
beforeAll(() => { db = appDb() })
afterAll(async () => { await db.end() })

const banner = ['SAMPLE PHARMACY', 'SHOP 1, SOME MALL', 'GABORONE', 'TEL: 000 0000']

async function sheet(path: string, title: string, reportDate: string, header: string[], rows: unknown[][], blankRows = 1) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  for (const b of banner) ws.addRow([b])
  ws.addRow([`Report Date: ${reportDate}`])
  ws.addRow([title])
  for (let i = 0; i < blankRows; i++) ws.addRow([])
  ws.addRow(header)
  for (const r of rows) ws.addRow(r)
  await wb.xlsx.writeFile(path)
}

// Synthetic exports shaped like Compharm's StockWin reports (made-up items, not shop data).
async function fixtures() {
  const dir = await mkdtemp(join(tmpdir(), 'sylken-import-'))
  const f = {
    itemList: join(dir, 'items.xlsx'), minMax: join(dir, 'minmax.xlsx'),
    usage: join(dir, 'usage.xlsx'), salesCsv: join(dir, 'sales.csv'),
  }
  await sheet(f.itemList, 'Stock Markup Report', '30 Sep 2026 22:39:09',
    ['Stock Code', 'Item Description', 'Cost', 'Retail', 'Markup %', 'GP %'], [
      ['6005894000352', 'COUGH SYRUP 100ML', 10, 17.1, 71, 41.5],
      ['USER0001', 'LOOSE TABLETS', 2, 3.42, 71, 41.5],
      ['USER0002', 'OLD CATALOGUE ITEM', 5, 8.55, 71, 41.5],
      ['USER0003', '', 1, 1.71, 71, 41.5],
      ['USER0004', 'TYPO COST', 13387138.67, 10, null, null],
      ['USER0005', 'NO PRICE', null, 0, null, 0],
      ['USER0006', 'OWN MARKUP', 10, 22.8, 128, 56],
    ])
  await sheet(f.minMax, 'Min - Max Level Order Report', '30 Sep 2026 21:51:58',
    ['Stock ID', 'Stock Code', 'Description', 'Packsize', 'Stock OH', 'Cost', 'Retail', 'Order Qty', 'Min Level', 'Max Level', 'BinLocation', 'Binlocation 2', 'Binlocation 3'], [
      [28, '6005894000352', 'COUGH SYRUP 100ML', 1, -1, 10, 17.1, 14.6, 3.4, 13.6, 'OTC-FLU', 'TOP100', ''],
      [29, 'USER0001', 'LOOSE TABLETS', 100, 0.53, 2, 3.42, 1.47, 1, 2, 'TABLETSA', '', ''],
    ], 3)
  const periods = ['202610', '202609', '202608']
  const header = ['StockCd', 'Descr', 'Pack Size', 'StockOH',
    'TP0Retail', ...periods.map((p) => `${p} Retail`), 'TP0Cost', ...periods.map((p) => `${p} Cost`),
    'TP0Qty', ...periods.map((p) => `${p} Quantity`), 'TP0Purch', ...periods.map((p) => `${p} Purchases`)]
  await sheet(f.usage, 'Stock Usage & History Per Item', '08 Oct 2026 21:55:42', header, [
    ['USER0001', 'LOOSE TABLETS', 100, 0.4, 3.42, 0, 3.42, 3.2, 2, 0, 2, 1.9, 0, 0, 0.3, 0.19, 0, 0, 1, 0],
    ['MISSING1', 'NOT IN ITEM LIST', 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ], 0)
  await writeFile(f.salesCsv, [
    'Stock Code,Stock Description,PackSize,StockOH(Packs),Qty,Cost,Retail,BinLocation,GP, Avg Retail,ScheduleNo',
    '6005894000352,COUGH SYRUP 100ML,1,6,59,590,1008.9,TOP100,41.5,17.1,2',
    'Totals,,,,,P590.00,P1 008.90,,,P17.10',
  ].join('\n'))
  return f
}

describe('Compharm import (synthetic exports)', () => {
  it('cleans, converts packs to units and keeps what the shop set', async () => {
    const t = await newTenant(db)
    const f = await fixtures()
    const report = await t.as((tx) => importCompharm(tx, { ...f, includeCatalogue: true }))
    expect(report.items).toBe(7)
    expect(report.quarantineReasons).toMatchObject({ 'no description': 1, 'cost looks wrong': 1, 'no cost': 1, 'no retail price': 1 })
    expect(report.issues.map((i) => i.issue)).toContain('in usage history but not in item list')

    const [syrup, tabs, old, own] = await t.as(async (tx) => Promise.all(['6005894000352', 'USER0001', 'USER0002', 'USER0006'].map((c) => findByCode(tx, c))))
    expect(syrup).toMatchObject({ status: 'active', onHandUnits: -1, bins: ['OTC-FLU', 'TOP100'], schedule: 2, barcodes: ['6005894000352'] })
    expect(syrup!.externalRefs).toMatchObject({ compharm_stock_id: 28 })
    // 0.53 packs of 100 is 53 units (from the 30 Sep min/max report, which wins over the later usage file)
    expect(tabs).toMatchObject({ packSize: 100, onHandUnits: 53, minUnits: 100, maxUnits: 200, minmaxSource: 'imported' })
    expect(old!.status).toBe('dormant')
    expect(own!.markupOverride).toBe(1)                 // 22.8 = 10 x 2.0 x 1.14, kept as a per-item markup
    expect(syrup!.markupOverride).toBeNull()             // on the shop's default rule

    const usage = await t.as((tx) => tx`select period, sold_units, purchased_units from usage_history where item_id = ${tabs!.id} order by period`)
    expect(usage.map((u) => [u.sold_units, u.purchased_units])).toEqual([[19, 0], [30, 100]])

    const ours = await t.as((tx) => minMaxOrderReport(tx))
    const cmp = compareMinMax(await readCompharmMinMax(f.minMax!), ours)
    expect(cmp).toMatchObject({ matched: 2, missing: [], extra: [], mismatches: [] })
  })

  it('by default skips catalogue lines that appear in no other export', async () => {
    const t = await newTenant(db)
    const report = await t.as(async (tx) => importCompharm(tx, await fixtures()))
    expect(report.items).toBe(2)                       // the syrup and the tablets
    expect(report.skippedCatalogue).toBe(5)
    expect(await t.as((tx) => findByCode(tx, 'USER0002'))).toBeNull()
  })

  it('refuses to import into a tenant that already has items', async () => {
    const t = await newTenant(db)
    const f = await fixtures()
    await t.as((tx) => importCompharm(tx, f))
    await expect(t.as((tx) => importCompharm(tx, f))).rejects.toThrow(/empty tenant/)
  })
})

// The real Friends Pharmacy exports are shop data and are not in the repository.
// Point SYLKEN_SEED_DIR at a folder holding them to run this check.
const seed = process.env.SYLKEN_SEED_DIR
const real = seed && existsSync(join(seed, 'MinMaxLevel_30Sep26.xlsx'))
describe.runIf(real)('Compharm import (Friends Pharmacy exports)', () => {
  it('loads every item and reproduces the 30 Sep min/max order report', async () => {
    const t = await newTenant(db)
    const report = await t.as((tx) => importCompharm(tx, {
      itemList: join(seed!, 'Item_List_Cost_Retail_30Sep26.xlsx'),
      minMax: join(seed!, 'MinMaxLevel_30Sep26.xlsx'),
      usage: join(seed!, 'Stock_Usage_History_All_08Oct26.xlsx'),
      salesCsv: join(seed!, 'Sales_Oct2025_All_Items.csv'),
    }))
    expect(report.items + report.skippedCatalogue).toBe(22682)
    expect(report.items).toBeGreaterThan(6000)
    expect(report.minMaxLevels).toBe(1581)
    const ours = await t.as((tx) => minMaxOrderReport(tx))
    const cmp = compareMinMax(await readCompharmMinMax(join(seed!, 'MinMaxLevel_30Sep26.xlsx')), ours)
    expect(cmp).toMatchObject({ compharmLines: 1581, matched: 1581, missing: [], extra: [], mismatches: [] })
  })
})
