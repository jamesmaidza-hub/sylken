import { describe, expect, it } from 'vitest'
import { parseScanFile } from '../src/domain/scanfile.js'

describe('handheld scanner files', () => {
  it('reads barcode,quantity lines and adds up repeat scans', () => {
    const p = parseScanFile('﻿Barcode,Qty\r\n6001234567890,5\r\n6009876543210,2\r\n6001234567890,3\r\n\u001A')
    expect(p.rows).toEqual([
      { code: '6001234567890', qty: 8, lines: [2, 4] },
      { code: '6009876543210', qty: 2, lines: [3] },
    ])
    expect(p.scans).toBe(3)
    expect(p.skipped).toEqual([])
  })

  it('reads the other common layouts', () => {
    const codes = (t: string) => parseScanFile(t).rows.map((r) => [r.code, r.qty])
    expect(codes('"6001234567890";"4"\n')).toEqual([['6001234567890', 4]])
    expect(codes('6001234567890\t0004\n')).toEqual([['6001234567890', 4]])
    expect(codes('6001234567890     0012\n')).toEqual([['6001234567890', 12]])
    expect(codes('3,6001234567890\n')).toEqual([['6001234567890', 3]])
    expect(codes('6001234567890,2,10/11/2026,14:02:11\n')).toEqual([['6001234567890', 2]])
    expect(codes('6001234567890,10/11/2026,14:02:11\n')).toEqual([['6001234567890', 1]])
    expect(codes('PANA500\nPANA500\n6001234567890\n')).toEqual([['PANA500', 2], ['6001234567890', 1]])
    expect(codes('0012345678905|1.5\n')).toEqual([['0012345678905', 1.5]])
  })

  it('lists lines it cannot read instead of guessing', () => {
    const p = parseScanFile('6001234567890,2\n??? ,\n6001234567890,-4\n')
    expect(p.rows).toEqual([{ code: '6001234567890', qty: 2, lines: [1] }])
    expect(p.skipped.map((s) => [s.line, s.reason])).toEqual([[2, 'not a barcode'], [3, 'quantity below zero']])
  })
})
