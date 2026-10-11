import type { Tx } from '../db/index.js'
import { money, numberOrNull, readReport, str } from './sheets.js'

/**
 * Compharm's "Stock Usage" (performers) report as an ABC sales snapshot: units sold, sales excl VAT and
 * cost for each item over the date range printed on the report. Items are matched on stock code; codes
 * sylken doesn't have are listed in the report and skipped.
 */

export interface AbcSalesReport { source: string; from: string; to: string; rows: number; loaded: number; notInSylken: string[] }

const iso = (d: string, m: string, y: string) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`

export async function importAbcSales(tx: Tx, file: string, source = 'Compharm stock usage'): Promise<AbcSalesReport> {
  const { rows, title } = await readReport(file, ['Stock Code'])
  const range = title.map((t) => t.match(/from\s+(\d{1,2})\/(\d{1,2})\/(\d{4}).*?to\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i)).find(Boolean)
  if (!range) throw new Error('could not read the "Usage from dd/mm/yyyy to dd/mm/yyyy" dates at the top of the report')
  const from = iso(range[1], range[2], range[3])
  const to = iso(range[4], range[5], range[6])

  const items = await tx`select id, stock_code from items`
  const idByCode = new Map(items.map((i) => [i.stock_code as string, i.id as string]))
  const report: AbcSalesReport = { source, from, to, rows: 0, loaded: 0, notInSylken: [] }

  const data = new Map<string, { item_id: string; qty_units: number; sales_excl: number; cost: number }>()
  for (const r of rows) {
    const code = str(r['Stock Code'])
    if (!code) continue
    report.rows++
    const id = idByCode.get(code)
    if (!id) { report.notInSylken.push(`${code} ${str(r['Description'])}`.trim()); continue }
    const d = data.get(id) ?? { item_id: id, qty_units: 0, sales_excl: 0, cost: 0 }
    d.qty_units += numberOrNull(r['Units']) ?? 0
    d.sales_excl += money(numberOrNull(r['Total Excl'])) ?? 0
    d.cost += money(numberOrNull(r['Total Cost'])) ?? 0
    data.set(id, d)
  }

  await tx`delete from abc_sales_snapshot where source = ${source} and period_from = ${from} and period_to = ${to}`
  const list = [...data.values()].map((d) => ({ ...d, period_from: from, period_to: to, source }))
  const [{ t }] = await tx`select current_setting('app.tenant_id') as t`
  for (let i = 0; i < list.length; i += 500) {
    await tx`insert into abc_sales_snapshot ${tx(list.slice(i, i + 500).map((d) => ({ ...d, tenant_id: t })) as any)}`
  }
  report.loaded = list.length
  return report
}
