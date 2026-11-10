/**
 * Reading the text file a handheld batch scanner makes (CipherLab 8000/8001/8200/8300/RK/RS with a
 * batch app, and most other brands). These files have one scan per line, usually
 * "barcode,quantity", but the separator, the order of the fields and any extra fields (date,
 * time, terminal number) depend on how the handheld was set up. So this reads all the common
 * layouts:
 *
 *   6001234567890,5            barcode and quantity, separated by , ; tab or |
 *   "6001234567890","5"        the same with quotes
 *   5,6001234567890            quantity first
 *   6001234567890   0005       fixed-width columns separated by spaces
 *   6001234567890,3,10/11/2026,14:02:11,01   with date, time and terminal number
 *   6001234567890              barcode only: every line is one item scanned
 *
 * A first line of column headings is skipped. The same code on several lines is added up.
 */

export interface ScanRow { code: string; qty: number; lines: number[] }
export interface SkippedLine { line: number; text: string; reason: string }
export interface ParsedScanFile { rows: ScanRow[]; scans: number; skipped: SkippedLine[] }

const isDate = (s: string) => /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/.test(s) || /^(19|20)\d{6}$/.test(s)
const isTime = (s: string) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(s)
const isQty = (s: string) => /^[+-]?\d{1,6}(\.\d{1,3})?$/.test(s)
/** A barcode or stock code: letters, digits and a few joiners, not a date or time. */
const isCode = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/.test(s) && !isDate(s) && !isTime(s)

function split(line: string): string[] {
  for (const sep of [',', ';', '\t', '|']) {
    if (line.includes(sep)) return line.split(sep).map(unquote)
  }
  return line.trim().split(/\s+/).map(unquote)
}

function unquote(s: string) {
  const t = s.trim()
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t
}

/** Pick the code and quantity out of one line's fields. */
function read(fields: string[]): { code: string; qty: number } | string {
  const f = fields.filter((x) => x !== '')
  if (!f.length) return 'empty'
  if (f.length === 1) return isCode(f[0]) ? { code: f[0], qty: 1 } : 'not a barcode'
  // The code is normally first. If the first field is a short number and a longer code follows,
  // the file is quantity first.
  let codeAt = 0
  if (isQty(f[0]) && f[0].replace(/\D/g, '').length <= 4 && f[1] && isCode(f[1]) && f[1].length > f[0].length) codeAt = 1
  const code = f[codeAt]
  if (!isCode(code)) return 'no barcode on this line'
  const qtyField = f.find((x, i) => i !== codeAt && isQty(x))
  if (qtyField === undefined) {
    // Only dates, times or text besides the code: a scan with no quantity counts as one.
    return f.every((x, i) => i === codeAt || isDate(x) || isTime(x) || !isQty(x)) ? { code, qty: 1 } : 'no quantity'
  }
  const qty = Number(qtyField)
  if (!Number.isFinite(qty)) return 'quantity is not a number'
  return { code, qty }
}

export function parseScanFile(text: string): ParsedScanFile {
  const lines = text.replace(/^﻿/, '').replace(/\u001A/g, '').split(/\r\n|\r|\n/)
  const byCode = new Map<string, ScanRow>()
  const skipped: SkippedLine[] = []
  let scans = 0
  let seenHeader = false
  lines.forEach((raw, i) => {
    const lineNo = i + 1
    if (!raw.trim()) return
    // Column headings ("Barcode,Qty") on the first line are not a scan.
    if (!scans && !skipped.length && !seenHeader && /barcode|code|qty|quantity|count|item|descr|date|time/i.test(raw) && !/\d{4,}/.test(raw)) {
      seenHeader = true
      return
    }
    const got = read(split(raw))
    if (typeof got === 'string') {
      skipped.push({ line: lineNo, text: raw.slice(0, 120), reason: got })
      return
    }
    if (got.qty < 0) { skipped.push({ line: lineNo, text: raw.slice(0, 120), reason: 'quantity below zero' }); return }
    scans++
    const row = byCode.get(got.code)
    if (row) { row.qty += got.qty; row.lines.push(lineNo) } else byCode.set(got.code, { code: got.code, qty: got.qty, lines: [lineNo] })
  })
  for (const r of byCode.values()) r.qty = Math.round(r.qty * 1000) / 1000
  return { rows: [...byCode.values()], scans, skipped }
}
