import ExcelJS from 'exceljs'
import { readFile } from 'node:fs/promises'
import { parse } from 'csv-parse/sync'

export type Row = Record<string, string | number | null>

function cellValue(v: ExcelJS.CellValue): string | number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    if ('result' in v) return cellValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue)
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('')
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text)
  }
  return String(v)
}

/**
 * Read a Compharm report export. The sheets open with 6-9 rows of shop name, address and report date,
 * so the header row is found by looking for a known first column name.
 */
export async function readReport(path: string, firstHeader: string[]): Promise<{ rows: Row[]; reportDate: Date | null; title: string[] }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load((await readFile(path)) as any)
  const ws = wb.worksheets[0]
  let header: string[] | null = null
  const rows: Row[] = []
  const title: string[] = []
  let reportDate: Date | null = null
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as ExcelJS.CellValue[]).slice(1).map(cellValue)
    if (!header) {
      const first = String(values[0] ?? '').trim()
      if (firstHeader.includes(first)) {
        header = values.map((v) => String(v ?? '').trim())
        return
      }
      if (first) title.push(first)
      const m = first.match(/^Report Date:\s*(\d{1,2} \w{3} \d{4})(?: (\d{2}:\d{2}:\d{2}))?/)
      if (m) reportDate = new Date(`${m[1]} ${m[2] ?? '00:00:00'} UTC`)
      return
    }
    const obj: Row = {}
    header.forEach((h, i) => { if (h) obj[h] = values[i] ?? null })
    rows.push(obj)
  })
  if (!header) throw new Error(`${path}: no header row starting with ${firstHeader.join(' or ')}`)
  return { rows, reportDate, title }
}

export async function readCsv(path: string): Promise<Row[]> {
  const text = await readFile(path, 'utf8')
  const records = parse(text, { columns: (h: string[]) => h.map((x) => x.trim()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true })
  return records as Row[]
}

export function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim()
}

export function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(String(v).replace(/[P\s,]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Excel stores these as floats (20.8899993896484); bring them back to what was typed. */
export function money(v: number | null, dp = 2): number | null {
  if (v === null) return null
  const f = 10 ** dp
  return Math.round(v * f) / f
}
