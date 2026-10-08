/** Retail per pack incl VAT from cost per pack excl VAT: cost x (1 + markup) x (1 + VAT), rounded up to the step. */
export function retailFromCost(costPerPack: number, markup: number, vatRate: number, step = 0.01): number {
  const raw = round2(costPerPack * (1 + markup) * (1 + vatRate))   // to the cent first, then up to the step
  const steps = Math.ceil(raw / step - 1e-9)
  return round2(steps * step)
}

/** Compharm-style markup %: (retail - cost) / cost, with retail incl VAT. */
export function markupPct(cost: number | null, retail: number): number | null {
  if (!cost) return null
  return ((retail - cost) / cost) * 100
}

/** Gross profit % on the selling price excl VAT. */
export function gpPct(cost: number | null, retail: number, vatRate: number): number | null {
  const excl = retail / (1 + vatRate)
  if (cost === null || excl <= 0) return null
  return ((excl - cost) / excl) * 100
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
