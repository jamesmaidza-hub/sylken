import ExcelJS from 'exceljs'
import type { Ctx } from './app.js'

/** A report column: its heading, the value exported for a row, and how it is formatted in Excel. */
export interface Col<T> {
  h: string
  v: (r: T) => string | number | null | undefined
  fmt?: 'money' | 'int' | 'pct' | 'qty'
}

export const csv = (rows: (string | number | null | undefined)[][]) =>
  rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\n')

const excelFormat = { money: '#,##0.00', int: '0', pct: '0.0', qty: '0.###' } as const

/** The report as an Excel workbook: one sheet, bold header row frozen at the top, numbers kept as numbers. */
export async function xlsx<T>(title: string, cols: Col<T>[], rows: T[]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'sylken'
  const ws = wb.addWorksheet(title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = cols.map((c) => ({
    header: c.h,
    width: Math.min(60, Math.max(c.h.length + 2, ...rows.slice(0, 200).map((r) => String(c.v(r) ?? '').length + 2), 8)),
    style: c.fmt ? { numFmt: excelFormat[c.fmt] } : {},
  }))
  ws.getRow(1).font = { bold: true }
  for (const r of rows) ws.addRow(cols.map((c) => c.v(r) ?? null))
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}

/**
 * Answer ?format=csv or ?format=xlsx with the report as a download, named after it and its
 * dates. Returns null when the screen was asked for instead.
 */
export async function download<T>(c: Ctx, file: string, title: string, cols: Col<T>[], rows: T[]) {
  const format = c.req.query('format')
  if (format === 'csv') {
    c.header('content-type', 'text/csv; charset=utf-8')
    c.header('content-disposition', `attachment; filename="${file}.csv"`)
    return c.body(csv([cols.map((x) => x.h), ...rows.map((r) => cols.map((x) => x.v(r)))]))
  }
  if (format === 'xlsx') {
    c.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    c.header('content-disposition', `attachment; filename="${file}.xlsx"`)
    return c.body(await xlsx(title, cols, rows))
  }
  return null
}

/** The current address with format set, for the download buttons. */
export function formatHref(c: Ctx, format: 'csv' | 'xlsx') {
  const q = new URLSearchParams(new URL(c.req.url).search)
  q.delete('ok'); q.delete('err')
  q.set('format', format)
  return `?${q}`
}
