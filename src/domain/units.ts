/** Stock is stored in whole units; screens and reports show packs. */
export function packsToUnits(packs: number, packSize: number): number {
  return Math.round(packs * packSize)
}

export function unitsToPacks(units: number, packSize: number): number {
  return Math.round((units / packSize) * 1000) / 1000
}

/** "3 x 25 + 4" style display for a unit count. */
export function formatPacks(units: number, packSize: number): string {
  if (packSize === 1) return String(units)
  const sign = units < 0 ? '-' : ''
  const abs = Math.abs(units)
  const packs = Math.floor(abs / packSize)
  const loose = abs % packSize
  if (!loose) return `${sign}${packs}`
  return packs ? `${sign}${packs} + ${loose}/${packSize}` : `${sign}${loose}/${packSize}`
}
