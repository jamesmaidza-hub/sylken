// The basket engine: how a sale's lines, discounts, VAT and totals are worked out. The till (in
// the browser, also offline) and the server import this same file, so a sale is priced by one
// set of rules wherever it is checked. Amounts are Pula incl VAT; refund lines are negative.

/** @param {number} n */
export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Price of a line at a pack price: units as a fraction of the pack price. Exact for whole packs. */
export function linePrice(/** @type {number} */ packPrice, /** @type {number} */ packSize, /** @type {number} */ units) {
  return round2((units / packSize) * packPrice)
}

/** Round a cash amount to the nearest step (Botswana has no coin below 5 thebe). Halves round away from zero. */
export function roundCash(/** @type {number} */ amount, /** @type {number} */ step) {
  if (!(step > 0.01)) return round2(amount)
  return round2(Math.sign(amount) * Math.round(Math.abs(amount) / step + 1e-9) * step)
}

/** VAT contained in a VAT-inclusive amount. */
export function vatIn(/** @type {number} */ amountIncl, /** @type {number} */ rate) {
  return round2((amountIncl * rate) / (1 + rate))
}

const cents = (/** @type {number} */ n) => Math.round(n * 100)

/**
 * How a line's price was changed from the list price, if it was:
 *  - { kind: 'discount', pct }  a percentage off
 *  - { kind: 'discount', off }  a flat amount off the line, in Pula
 *  - { kind: 'override', packPrice }  a new price per pack typed in
 * @typedef {{ kind: 'discount', pct?: number, off?: number } | { kind: 'override', packPrice: number } | null} Adjust
 */

/**
 * List and charged totals for one line.
 * @param {{ packPrice: number, packSize: number, units: number, adjust?: Adjust }} l
 */
export function priceLine(l) {
  const listTotal = linePrice(l.packPrice, l.packSize, l.units)
  const a = l.adjust
  let lineTotal = listTotal
  if (a && a.kind === 'discount' && a.pct) lineTotal = round2(listTotal * (1 - a.pct / 100))
  else if (a && a.kind === 'discount' && a.off) lineTotal = round2(listTotal - Math.sign(listTotal) * Math.min(Math.abs(a.off), Math.abs(listTotal)))
  else if (a && a.kind === 'override') lineTotal = linePrice(a.packPrice, l.packSize, l.units)
  return { listTotal, lineTotal }
}

/** The discount on a line as a percentage of its list price (0 when it is not cheaper). */
export function discountPct(/** @type {number} */ listTotal, /** @type {number} */ lineTotal) {
  if (!listTotal || Math.abs(lineTotal) >= Math.abs(listTotal)) return 0
  return Math.round(((Math.abs(listTotal) - Math.abs(lineTotal)) / Math.abs(listTotal)) * 10000) / 100
}

/**
 * Is a line's charged price within a discount of `pct` off its list price? Worked out the same way
 * the till applies a percentage (to the cent, halves up), so a discount of exactly the limit passes.
 */
export function withinDiscount(/** @type {number} */ listTotal, /** @type {number} */ lineTotal, /** @type {number} */ pct) {
  return cents(Math.abs(lineTotal)) >= cents(round2(Math.abs(listTotal) * (1 - pct / 100)))
}

/**
 * What a supervisor has to allow before this line can be sold, or null.
 * A discount up to the cashier's limit needs nobody; more than that, or any price typed in, does.
 * @param {{ listTotal: number, lineTotal: number, adjust?: 'discount' | 'override' | null }} l
 * @param {number} cashierLimitPct
 * @returns {'discount' | 'price_override' | null}
 */
export function approvalNeeded(l, cashierLimitPct) {
  if (l.adjust === 'override') return 'price_override'
  if (l.adjust === 'discount') return withinDiscount(l.listTotal, l.lineTotal, cashierLimitPct) ? null : 'discount'
  return null
}

/**
 * Totals for a whole basket: list subtotal, discounts, VAT per rate and the grand total.
 * Called on every change to the basket (add, remove, quantity, price) so every figure moves together.
 * sylken has no promotions yet; `promotions` is always empty until there are some to apply.
 * @param {{ listTotal: number, lineTotal: number, vatRate: number }[]} lines
 */
export function basketTotals(lines) {
  /** @type {Map<number, { rate: number, gross: number, vat: number }>} */
  const byRate = new Map()
  let subtotal = 0, total = 0
  for (const l of lines) {
    subtotal += cents(l.listTotal)
    total += cents(l.lineTotal)
    const r = byRate.get(l.vatRate) || { rate: l.vatRate, gross: 0, vat: 0 }
    r.gross = round2(r.gross + l.lineTotal)
    r.vat = round2(r.vat + vatIn(l.lineTotal, l.vatRate))
    byRate.set(l.vatRate, r)
  }
  const vatByRate = [...byRate.values()].sort((a, b) => b.rate - a.rate).map((r) => ({ ...r, net: round2(r.gross - r.vat) }))
  return {
    subtotal: subtotal / 100,
    discount: (subtotal - total) / 100,
    promotions: /** @type {{ label: string, amount: number }[]} */ ([]),
    vatByRate,
    vat: round2(vatByRate.reduce((a, r) => a + r.vat, 0)),
    total: total / 100,
  }
}

/**
 * Change for a cash payment, and whether it is within the shop's limit. A change amount above the
 * limit is almost always a typing slip (P1000 typed for P10), so the payment is refused.
 */
export function cashChange(/** @type {number} */ tendered, /** @type {number} */ due, /** @type {number} */ maxChange) {
  const change = round2(tendered - due)
  return { change: Math.max(0, change), tooMuch: cents(change) > cents(maxChange) }
}

/** Notes and coins in use in Botswana, largest first. */
export const denominations = [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05]

/** Total of a count of notes and coins: { "200": 3, "0.5": 4 } is P602.00. */
export function countTotal(/** @type {Record<string, number>} */ counts) {
  let c = 0
  for (const [d, q] of Object.entries(counts)) c += cents(Number(d)) * q
  return c / 100
}
