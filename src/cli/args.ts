/** Tiny --flag value parser for the CLIs. */
export function args(): Record<string, string> {
  const out: Record<string, string> = {}
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue
    const key = a[i].slice(2)
    const next = a[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = 'true'
    else { out[key] = next; i++ }
  }
  return out
}
