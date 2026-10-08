import { describe, expect, it } from 'vitest'
import { isGtin } from '../src/domain/barcodes.js'
import { gpPct, markupPct, retailFromCost } from '../src/domain/pricing.js'
import { formatPacks, packsToUnits, unitsToPacks } from '../src/domain/units.js'
import { compareMinMax } from '../src/import/check.js'

describe('pricing', () => {
  it('applies markup then VAT, as Friends Pharmacy prices (50% + 14% VAT = 71%)', () => {
    expect(retailFromCost(3.87, 0.5, 0.14)).toBe(6.62)
    expect(retailFromCost(100, 0.5, 0.14)).toBe(171)
  })
  it('rounds up to the price step after rounding to the cent', () => {
    expect(retailFromCost(10, 0.5, 0.14, 0.05)).toBe(17.1)
    expect(retailFromCost(10.01, 0.5, 0.14, 0.1)).toBe(17.2)
    expect(retailFromCost(66.3, 0.3767, 0.14)).toBe(104.05)
  })
  it('markup matches Compharm and GP takes VAT off first', () => {
    expect(markupPct(12.2, 20.89)).toBeCloseTo(71.2295, 3)
    expect(gpPct(100, 171, 0.14)).toBeCloseTo(33.33, 2)
    expect(markupPct(null, 10)).toBeNull()
  })
})

describe('units', () => {
  it('stores fractional Compharm packs as whole units', () => {
    expect(packsToUnits(0.53, 100)).toBe(53)
    expect(packsToUnits(-3.6666666, 150)).toBe(-550)
    expect(unitsToPacks(374, 100)).toBe(3.74)
  })
  it('shows packs plus loose units', () => {
    expect(formatPacks(78, 25)).toBe('3 + 3/25')
    expect(formatPacks(-2, 25)).toBe('-2/25')
    expect(formatPacks(50, 25)).toBe('2')
    expect(formatPacks(7, 1)).toBe('7')
  })
})

describe('barcodes', () => {
  it('accepts valid GTINs only', () => {
    expect(isGtin('6005894000352')).toBe(true)
    expect(isGtin('6005894000353')).toBe(false)
    expect(isGtin('USER0001')).toBe(false)
    expect(isGtin('96385074')).toBe(true)
  })
})

describe('min/max comparison', () => {
  it('flags missing, extra and different lines', () => {
    const ours: any[] = [{ stockCode: 'A', orderPacks: 2 }, { stockCode: 'C', orderPacks: 1 }]
    const r = compareMinMax([{ stockCode: 'A', orderPacks: 2.004 }, { stockCode: 'B', orderPacks: 1 }], ours)
    expect(r.matched).toBe(1)
    expect(r.missing).toEqual(['B'])
    expect(r.extra).toEqual(['C'])
  })
})
