/**
 * A simple in-memory counter of attempts per key (an IP address) in a sliding window. It
 * lives in one process, which is fine for one server or one shop PC; several app servers
 * would need a shared store.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(private max: number, private windowMs: number) {}

  /** Record an attempt; false if this key has used up its attempts. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs)
    if (recent.length >= this.max) { this.hits.set(key, recent); return false }
    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > 10_000) this.prune(now)
    return true
  }

  reset() { this.hits.clear() }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => t > now - this.windowMs)) this.hits.delete(k)
  }
}
