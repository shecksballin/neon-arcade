/**
 * RATE LIMIT — in-memory sliding window
 * =====================================
 * The same limiter routes/auth.ts uses, extracted so profile routes can
 * throttle PIN/TOTP attempts with their own window. Security protocol:
 * per-wallet keys, small budgets. Moves to Redis when the API runs more
 * than one instance (in-memory state is per-process).
 */

export function createRateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, number[]>()

  /** True if `key` has exceeded `max` requests inside the window. */
  return function rateLimited(key: string): boolean {
    const now = Date.now()
    const windowStart = now - windowMs
    const recent = (hits.get(key) ?? []).filter((t) => t > windowStart)
    if (recent.length >= max) {
      hits.set(key, recent)
      return true
    }
    recent.push(now)
    hits.set(key, recent)
    return false
  }
}
