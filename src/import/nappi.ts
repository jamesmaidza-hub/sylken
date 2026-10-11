import ExcelJS from 'exceljs'
import type { Tx } from '../db/index.js'
import { readReport, numberOrNull, str } from './sheets.js'

/**
 * NAPPI codes from Compharm's "Drug Usage" report. RxWin has no stock code on that report, so a code
 * is only put on an item when the description matches exactly (ignoring case and punctuation) to one
 * sylken item and the pack size agrees. Everything else goes on the unmatched list.
 */

export interface NappiReport { rows: number; matched: number; unmatched: { code: string; description: string; packSize: number | null; why: string; sameName: string }[] }

const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9%./ ]/g, ' ').replace(/\s+/g, ' ').trim()
const USUAL_FORM = /^\d{6,9}(-\d{1,3})?$/

export async function importNappi(tx: Tx, file: string): Promise<NappiReport> {
  const { rows } = await readReport(file, ['Nappi Code'])
  const items = await tx`select id, stock_code, description, pack_size, nappi_code from items`
  const byName = new Map<string, typeof items>()
  for (const i of items) { const k = norm(i.description); byName.set(k, [...(byName.get(k) ?? []), i] as any) }

  const report: NappiReport = { rows: rows.length, matched: 0, unmatched: [] }
  const taken = new Set<string>()
  for (const r of rows) {
    const code = str(r['Nappi Code'])
    const description = str(r['Description'])
    const packSize = numberOrNull(r['Pack Size'])
    const found = byName.get(norm(description)) ?? []
    const sameName = found.map((i) => i.stock_code).join(', ')
    const no = (why: string) => report.unmatched.push({ code, description, packSize, why, sameName })
    if (!description) continue
    if (!code) { no('no NAPPI code in RxWin'); continue }
    if (!USUAL_FORM.test(code)) { no('NAPPI code not in the usual form'); continue }
    if (!found.length) { no('no sylken item with this name'); continue }
    if (found.length > 1) { no('more than one sylken item with this name'); continue }
    const item = found[0]
    if (packSize && Number(item.pack_size) !== packSize) { no(`pack size differs (sylken ${item.pack_size})`); continue }
    if (taken.has(item.id)) { no('another NAPPI code already went to this item'); continue }
    taken.add(item.id)
    await tx`update items set nappi_code = ${code} where id = ${item.id}`
    report.matched++
  }
  return report
}

export async function writeUnmatched(report: NappiReport, path: string) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Not matched')
  ws.addRow(['NAPPI code (RxWin)', 'Description (RxWin)', 'Pack size', 'Why not matched', 'sylken stock codes with the same name'])
  for (const u of report.unmatched) ws.addRow([u.code, u.description, u.packSize, u.why, u.sameName])
  ws.getRow(1).font = { bold: true }
  await wb.xlsx.writeFile(path)
}
