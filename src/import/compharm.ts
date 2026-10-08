import type { Tx } from '../db/index.js'
import { isGtin } from '../domain/barcodes.js'
import { getSettings } from '../domain/settings.js'
import { money, numberOrNull, readCsv, readReport, str, type Row } from './sheets.js'

/**
 * Import Compharm StockWin report exports into an empty tenant.
 *
 * Files (only the item list is required):
 *  - itemList:  "Stock Markup Report" (Stock Code, Item Description, Cost, Retail, Markup %, GP %)
 *  - minMax:    "Min - Max Level Order Report" (Stock ID, ..., Stock OH, Min Level, Max Level, BinLocation 1-3)
 *  - usage:     "Stock Usage & History Per Item" (StockCd, ..., monthly Retail/Cost/Quantity/Purchases)
 *  - salesCsv:  monthly item sales CSV (PackSize, BinLocation, ScheduleNo)
 *
 * Compharm counts stock in packs (often fractional); sylken stores whole units, so every
 * quantity is converted with the item's pack size.
 */
export interface CompharmFiles {
  itemList: string
  minMax?: string
  usage?: string
  salesCsv?: string
  /** Also import item-list lines that appear in no other export (the supplier catalogue). Off by default. */
  includeCatalogue?: boolean
}

export interface ImportIssue {
  stockCode: string
  issue: string
  detail?: string
}

export interface ImportReport {
  items: number
  skippedCatalogue: number
  active: number
  dormant: number
  quarantined: number
  barcodes: number
  bins: number
  openingBalances: number
  minMaxLevels: number
  usageRows: number
  priceHistoryRows: number
  schedules: number
  packSizesKnown: number
  sources: Record<string, { file: string; rows: number; reportDate: string | null }>
  quarantineReasons: Record<string, number>
  issues: ImportIssue[]
}

const PLACEHOLDER_DESC = /^(z{2,}|x{2,}|\.+|-+|test|n\/a)$/i

interface Draft {
  code: string
  description: string
  cost: number | null
  retail: number
  packSize: number
  packSizeKnown: boolean
  schedule: number | null
  bins: string[]
  compharmStockId: number | null
  status: 'active' | 'dormant' | 'quarantined'
  reason: string | null
  openingPacks: number | null
  openingAsOf: Date | null
  minPacks: number | null
  maxPacks: number | null
  active: boolean
  seen: boolean      // appears in the min/max, usage or sales export
}

export async function importCompharm(tx: Tx, files: CompharmFiles): Promise<ImportReport> {
  await primeTenant(tx)
  const settings = await getSettings(tx)
  const [{ n: existing }] = await tx`select count(*)::int as n from items`
  if (existing > 0) throw new Error(`tenant already has ${existing} items; import only runs into an empty tenant`)

  const issues: ImportIssue[] = []
  const sources: ImportReport['sources'] = {}
  const drafts = new Map<string, Draft>()

  // 1. Item master
  const itemList = await readReport(files.itemList, ['Stock Code'])
  sources.itemList = { file: files.itemList, rows: itemList.rows.length, reportDate: itemList.reportDate?.toISOString() ?? null }
  for (const r of itemList.rows) {
    const code = str(r['Stock Code'])
    if (!code) continue
    if (drafts.has(code)) { issues.push({ stockCode: code, issue: 'duplicate stock code in item list', detail: 'kept the first row' }); continue }
    drafts.set(code, {
      code, description: str(r['Item Description']).replace(/\s+/g, ' '),
      cost: money(numberOrNull(r['Cost']), 4), retail: money(numberOrNull(r['Retail'])) ?? 0,
      packSize: 1, packSizeKnown: false, schedule: null, bins: [], compharmStockId: null,
      status: 'active', reason: null, openingPacks: null, openingAsOf: null, minPacks: null, maxPacks: null, active: false, seen: false,
    })
  }

  const fill = (code: string, r: { description?: string; packSize?: number | null; bins?: string[] }) => {
    const d = drafts.get(code)
    if (!d) return null
    d.seen = true
    if (!d.description && r.description) d.description = r.description.replace(/\s+/g, ' ')
    if (r.packSize && !d.packSizeKnown && Number.isInteger(r.packSize) && r.packSize > 0) { d.packSize = r.packSize; d.packSizeKnown = true }
    if (r.bins && !d.bins.length) d.bins = r.bins.map((b) => b.toUpperCase()).filter(Boolean)
    return d
  }

  // 2. Min/max report: Compharm stock id, pack size, bins, stock on hand and levels as at the report date
  let minMaxRows: Row[] = []
  if (files.minMax) {
    const mm = await readReport(files.minMax, ['Stock ID'])
    minMaxRows = mm.rows
    sources.minMax = { file: files.minMax, rows: mm.rows.length, reportDate: mm.reportDate?.toISOString() ?? null }
    for (const r of mm.rows) {
      const code = str(r['Stock Code'])
      if (!code) continue
      const d = fill(code, {
        description: str(r['Description']), packSize: numberOrNull(r['Packsize']),
        bins: [str(r['BinLocation']), str(r['Binlocation 2']), str(r['Binlocation 3'])],
      })
      if (!d) { issues.push({ stockCode: code, issue: 'in min/max report but not in item list', detail: 'skipped' }); continue }
      d.compharmStockId = numberOrNull(r['Stock ID'])
      d.openingPacks = numberOrNull(r['Stock OH'])
      d.openingAsOf = mm.reportDate
      d.minPacks = numberOrNull(r['Min Level'])
      d.maxPacks = numberOrNull(r['Max Level'])
      d.active = true
      if (d.minPacks !== null && d.maxPacks !== null && d.minPacks > d.maxPacks) {
        issues.push({ stockCode: code, issue: 'min level above max level', detail: `min ${d.minPacks}, max ${d.maxPacks} packs; imported as is` })
      }
    }
  }

  // 3. Sales CSV: pack size, bin and drug schedule
  if (files.salesCsv) {
    const rows = await readCsv(files.salesCsv)
    sources.salesCsv = { file: files.salesCsv, rows: rows.length, reportDate: null }
    for (const r of rows) {
      const code = str(r['Stock Code'])
      if (!code || code.toLowerCase() === 'totals') continue
      const d = fill(code, { description: str(r['Stock Description']), packSize: numberOrNull(r['PackSize']), bins: [str(r['BinLocation'])] })
      if (!d) { issues.push({ stockCode: code, issue: 'in sales file but not in item list', detail: 'skipped' }); continue }
      const sch = numberOrNull(r['ScheduleNo'])
      if (sch !== null && d.schedule === null) d.schedule = sch
      if ((numberOrNull(r['Qty']) ?? 0) !== 0) d.active = true
    }
  }

  // 4. Usage history: pack size, stock on hand (if not already from min/max), monthly sales and purchases, price changes
  type Month = { period: Date; sold: number; purchased: number; retail: number | null; cost: number | null }
  const usage = new Map<string, Month[]>()
  if (files.usage) {
    const u = await readReport(files.usage, ['StockCd'])
    sources.usage = { file: files.usage, rows: u.rows.length, reportDate: u.reportDate?.toISOString() ?? null }
    const periods = Object.keys(u.rows[0] ?? {})
      .map((k) => k.match(/^(\d{6}) Quantity$/)?.[1]).filter((p): p is string => !!p).sort()
    for (const r of u.rows) {
      const code = str(r['StockCd'])
      if (!code) continue
      const d = fill(code, { description: str(r['Descr']), packSize: numberOrNull(r['Pack Size']) })
      if (!d) { issues.push({ stockCode: code, issue: 'in usage history but not in item list', detail: 'skipped' }); continue }
      const oh = numberOrNull(r['StockOH'])
      if (d.openingPacks === null && oh !== null) { d.openingPacks = oh; d.openingAsOf = u.reportDate }
      const months: Month[] = periods.map((p) => ({
        period: new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(4)) - 1, 1)),
        sold: numberOrNull(r[`${p} Quantity`]) ?? 0,
        purchased: numberOrNull(r[`${p} Purchases`]) ?? 0,
        retail: money(numberOrNull(r[`${p} Retail`])),
        cost: money(numberOrNull(r[`${p} Cost`]), 4),
      }))
      usage.set(code, months)
      if (months.some((m) => m.sold !== 0 || m.purchased !== 0) || (oh ?? 0) !== 0) d.active = true
    }
  }

  // 5. Decide each item's status. Quarantined items stay searchable but can't be sold until fixed.
  const quarantineReasons: Record<string, number> = {}
  for (const d of drafts.values()) {
    if (!files.includeCatalogue && !d.seen) continue
    const reasons: string[] = []
    if (!d.description || PLACEHOLDER_DESC.test(d.description)) reasons.push('no description')
    else if (/^\d{6,}$/.test(d.description)) reasons.push('description is a barcode')
    if (d.cost === null || d.cost === 0) reasons.push('no cost')
    else if (d.cost > settings.maxSaneCost) reasons.push(`cost P${d.cost.toLocaleString('en')} looks wrong`)
    if (d.retail <= 0) reasons.push('no retail price')
    if (reasons.length) {
      d.status = 'quarantined'
      d.reason = reasons.join('; ')
      for (const r of reasons) {
        const key = r.startsWith('cost P') ? 'cost looks wrong' : r
        quarantineReasons[key] = (quarantineReasons[key] ?? 0) + 1
      }
      if (d.active) issues.push({ stockCode: d.code, issue: 'active item quarantined', detail: d.reason })
    } else if (!d.active) {
      d.status = 'dormant'
      d.reason = 'no stock or movement in the Compharm exports'
    }
    if (d.cost !== null && d.retail > 0 && d.cost > d.retail && d.status !== 'quarantined') {
      issues.push({ stockCode: d.code, issue: 'retail below cost', detail: `cost P${d.cost}, retail P${d.retail}` })
    }
  }

  // 6. Write items in batches
  // The item list holds Compharm's whole product file. By default only items the shop has
  // stocked, sold or bought (they appear in another export) come in; new lines arrive on invoices.
  const list = [...drafts.values()].filter((d) => files.includeCatalogue || d.seen)
  const skippedCatalogue = drafts.size - list.length
  const idByCode = new Map<string, string>()
  for (let i = 0; i < list.length; i += 1000) {
    const chunk = list.slice(i, i + 1000).map((d) => ({
      markup_override: keptMarkup(d, settings),
      tenant_id: tenantId(tx), stock_code: d.code, description: d.description,
      pack_size: d.packSize, pack_size_known: d.packSizeKnown, sell_loose: d.packSize > 1,
      cost_per_pack: d.cost, avg_cost_per_pack: d.cost, retail_per_pack: d.retail, schedule: d.schedule,
      status: d.status, status_reason: d.reason,
      external_refs: { compharm_stock_code: d.code, ...(d.compharmStockId !== null ? { compharm_stock_id: d.compharmStockId } : {}) },
    }))
    const rows = await tx`insert into items ${tx(chunk as any)} returning id, stock_code`
    for (const r of rows) idByCode.set(r.stock_code, r.id)
  }

  // 7. Barcodes: stock codes that are valid GTINs are also scannable barcodes
  const barcodeRows = list.filter((d) => isGtin(d.code)).map((d) => ({ item_id: idByCode.get(d.code)!, barcode: d.code }))
  await insertChunked(tx, 'item_barcodes', barcodeRows)

  // 8. Bins
  const binNames = [...new Set(list.flatMap((d) => d.bins))]
  const binIds = new Map<string, string>()
  if (binNames.length) {
    const rows = await tx`insert into bins ${tx(binNames.map((name) => ({ tenant_id: tenantId(tx), name })) as any)} returning id, name`
    for (const r of rows) binIds.set(r.name, r.id)
  }
  const itemBins = list.flatMap((d) => [...new Set(d.bins)].map((b, i) => ({ item_id: idByCode.get(d.code)!, bin_id: binIds.get(b)!, position: i + 1 })))
  await insertChunked(tx, 'item_bins', itemBins)

  // 9. Opening balances, as ledger movements, dated at the report they came from
  let openingBalances = 0
  const movements = list.filter((d) => d.openingPacks).map((d) => {
    const units = Math.round(d.openingPacks! * d.packSize)
    const exact = d.openingPacks! * d.packSize
    if (Math.abs(units - exact) > 0.05) {
      issues.push({ stockCode: d.code, issue: 'stock on hand not a whole number of units', detail: `${d.openingPacks} packs x ${d.packSize} = ${exact.toFixed(3)}, rounded to ${units}` })
    }
    return { d, units }
  }).filter((m) => m.units !== 0)
  for (let i = 0; i < movements.length; i += 1000) {
    const chunk = movements.slice(i, i + 1000).map(({ d, units }) => ({
      tenant_id: tenantId(tx), item_id: idByCode.get(d.code)!, kind: 'opening', qty_units: units,
      unit_cost: d.cost !== null && d.cost <= settings.maxSaneCost ? d.cost / d.packSize : null,
      unit_retail: d.retail / d.packSize, ref_type: 'compharm_import',
      note: `Compharm stock on hand ${d.openingPacks} packs`, occurred_at: d.openingAsOf ?? new Date(),
    }))
    await tx`insert into stock_movements ${tx(chunk as any)}`
    openingBalances += chunk.length
  }

  // 10. Min/max levels in units
  const levels = list.filter((d) => d.minPacks !== null && d.maxPacks !== null).map((d) => ({
    item_id: idByCode.get(d.code)!, min_units: round3(d.minPacks! * d.packSize), max_units: round3(d.maxPacks! * d.packSize),
  }))
  for (let i = 0; i < levels.length; i += 1000) {
    const chunk = levels.slice(i, i + 1000)
    await tx`
      insert into stock_levels (tenant_id, item_id, on_hand_units, min_units, max_units, minmax_source)
      select current_setting('app.tenant_id')::uuid, x.item_id, 0, x.min_units, x.max_units, 'imported'
        from jsonb_to_recordset(${tx.json(chunk as any)}) as x(item_id uuid, min_units numeric, max_units numeric)
      on conflict (item_id) do update set min_units = excluded.min_units, max_units = excluded.max_units, minmax_source = 'imported'`
  }

  // 11. Usage history and price history
  const usageRows: Record<string, unknown>[] = []
  const priceRows: Record<string, unknown>[] = []
  for (const [code, months] of usage) {
    const d = drafts.get(code)!
    const itemId = idByCode.get(code)
    if (!itemId) continue
    for (const m of months) {
      const sold = Math.round(m.sold * d.packSize)
      const purchased = Math.round(m.purchased * d.packSize)
      if (sold || purchased) usageRows.push({ item_id: itemId, period: m.period, sold_units: sold, purchased_units: purchased, source: 'compharm_usage' })
    }
    let last: { retail: number | null; cost: number | null } | null = null
    for (const m of months) {
      if (!m.retail && !m.cost) continue           // months with no data (e.g. the month the report was run)
      if (last && last.retail === m.retail && last.cost === m.cost) continue
      if (m.cost !== null && m.cost > settings.maxSaneCost) continue
      priceRows.push({ item_id: itemId, cost_per_pack: m.cost, retail_per_pack: m.retail, effective_from: m.period, source: 'import' })
      last = { retail: m.retail, cost: m.cost }
    }
  }
  for (const d of list) {
    if (d.cost !== null && d.cost > settings.maxSaneCost) continue
    priceRows.push({ item_id: idByCode.get(d.code)!, cost_per_pack: d.cost, retail_per_pack: d.retail, effective_from: itemList.reportDate ?? new Date(), source: 'import' })
  }
  await insertChunked(tx, 'usage_history', usageRows)
  await insertChunked(tx, 'price_history', priceRows)

  return {
    items: list.length,
    skippedCatalogue,
    active: list.filter((d) => d.status === 'active').length,
    dormant: list.filter((d) => d.status === 'dormant').length,
    quarantined: list.filter((d) => d.status === 'quarantined').length,
    barcodes: barcodeRows.length,
    bins: binNames.length,
    openingBalances,
    minMaxLevels: levels.length,
    usageRows: usageRows.length,
    priceHistoryRows: priceRows.length,
    schedules: list.filter((d) => d.schedule !== null).length,
    packSizesKnown: list.filter((d) => d.packSizeKnown).length,
    sources,
    quarantineReasons,
    issues,
  }
}

// Bulk inserts name the tenant explicitly; the session's tenant id is read once per transaction.
const tenantCache = new WeakMap<object, string>()
function tenantId(tx: Tx): string {
  const t = tenantCache.get(tx)
  if (!t) throw new Error('call primeTenant(tx) before importing')
  return t
}

export async function primeTenant(tx: Tx) {
  const [{ t }] = await tx`select current_setting('app.tenant_id') as t`
  tenantCache.set(tx, t)
}

async function insertChunked(tx: Tx, table: string, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000).map((r) => ({ tenant_id: tenantId(tx), ...r }))
    await tx`insert into ${tx(table)} ${tx(chunk as any)}`
  }
}

/** The min/max rows as Compharm reported them, for checking sylken's own order report. */
export async function readCompharmMinMax(path: string) {
  const mm = await readReport(path, ['Stock ID'])
  return mm.rows.filter((r) => str(r['Stock Code'])).map((r) => ({
    stockCode: str(r['Stock Code']),
    description: str(r['Description']),
    packSize: numberOrNull(r['Packsize']) ?? 1,
    onHandPacks: numberOrNull(r['Stock OH']) ?? 0,
    minPacks: numberOrNull(r['Min Level']) ?? 0,
    maxPacks: numberOrNull(r['Max Level']) ?? 0,
    orderPacks: numberOrNull(r['Order Qty']) ?? 0,
  }))
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000
}

/**
 * Keep each item's existing Compharm markup when it differs from the shop's default rule,
 * so re-pricing on receipt doesn't silently move prices the shop set on purpose.
 */
function keptMarkup(d: Draft, settings: { defaultMarkup: number; vatRate: number; maxSaneCost: number }): number | null {
  if (d.status === 'quarantined' || !d.cost || d.cost > settings.maxSaneCost || d.retail <= 0) return null
  const markup = d.retail / (d.cost * (1 + settings.vatRate)) - 1
  if (Math.abs(markup - settings.defaultMarkup) < 0.005 || markup > 99 || markup < -0.99) return null
  return Math.round(markup * 10000) / 10000
}
