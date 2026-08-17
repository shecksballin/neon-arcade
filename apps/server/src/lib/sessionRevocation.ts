/**
 * SESSION REVOCATION — making "sign out" mean something server-side
 * ================================================================
 * Session JWTs are stateless: `requireAuth` verifies a signature and an
 * expiry and asks nobody's permission. That is why it is fast, and it was
 * fine when tokens lived 24 hours. With 30-day sessions it stopped being
 * fine — signing out dropped the browser's copy of the token and did
 * nothing whatsoever about the same token sitting in another tab, on a
 * phone, or in a proxy log. It stayed valid for a month.
 *
 * So each account carries a revocation stamp, `users.sessions_valid_from`
 * (epoch seconds), and a token is refused when it was issued before it.
 * One column, one comparison, no session table.
 *
 * THE COST, AND WHY IT IS SMALL
 * -----------------------------
 * A stateless check becomes a database read on every authenticated
 * request, so the stamp is cached per wallet for 30 seconds. Signing out
 * evicts the entry in the same process immediately, so the tab that did it
 * sees the effect at once; other instances converge within the TTL. That
 * window is the deliberate trade — a sign-out that takes effect
 * everywhere inside half a minute, for one query per wallet per 30s
 * rather than one per request.
 *
 * FAIL OPEN, ON PURPOSE
 * ---------------------
 * If the lookup fails (database hiccup) the token is ACCEPTED. It is
 * cryptographically valid and unexpired; refusing it would turn a brief
 * database blip into "everyone is signed out". Revocation is a
 * best-effort tightening of an already-authenticated request, not the
 * authentication itself.
 */

import { eq } from 'drizzle-orm'
import { requireDb } from '../db'
import { users } from '../db/schema'

/** How long a wallet's revocation stamp is trusted without re-reading. */
const CACHE_TTL_MS = 30 * 1000

interface CacheEntry {
  /** Epoch seconds, or null when the account has never signed out. */
  validFrom: number | null
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Drop a wallet's cached stamp so the next check re-reads it.
 * Called right after a sign-out writes one.
 */
export function forgetRevocation(wallet: string): void {
  cache.delete(wallet)
}

/** Read the stamp, via the cache. Returns null when nothing is revoked. */
async function readValidFrom(wallet: string): Promise<number | null> {
  const cached = cache.get(wallet)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.validFrom
  }

  const db = requireDb()
  if (!db) return null

  const [row] = await db
    .select({ validFrom: users.sessionsValidFrom })
    .from(users)
    .where(eq(users.wallet, wallet))
    .limit(1)

  // An unknown wallet caches `null` too: it has no account, so it has
  // nothing revoked, and caching it stops a bogus token from producing a
  // database read per request.
  const validFrom = row?.validFrom ?? null
  cache.set(wallet, { validFrom, fetchedAt: Date.now() })

  // Keep the map from growing without bound on a long-lived process.
  if (cache.size > 10_000) {
    const cutoff = Date.now() - CACHE_TTL_MS
    for (const [key, entry] of cache) {
      if (entry.fetchedAt < cutoff) cache.delete(key)
    }
  }

  return validFrom
}

/**
 * True when this token was issued before the account's last sign-out and
 * must be refused. `issuedAt` is the JWT's `iat` claim, in seconds.
 */
export async function isSessionRevoked(
  wallet: string,
  issuedAt: unknown
): Promise<boolean> {
  // A token with no usable `iat` cannot be placed relative to a sign-out.
  // Every token this server mints has one (see mintSessionToken), so this
  // is a malformed or foreign token — and it is refused.
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return true

  try {
    const validFrom = await readValidFrom(wallet)
    return validFrom !== null && issuedAt < validFrom
  } catch (err) {
    console.error('[auth] revocation check failed, allowing the token:', err)
    return false
  }
}

/**
 * End every session for this account: stamp `sessions_valid_from` with
 * now, so every token minted up to this second stops working.
 *
 * Returns false when there was no account row to stamp (the caller should
 * still tear down the client session — there is simply nothing to revoke).
 */
export async function revokeSessions(wallet: string): Promise<boolean> {
  const db = requireDb()
  if (!db) return false

  const now = Math.floor(Date.now() / 1000)
  const [row] = await db
    .update(users)
    .set({ sessionsValidFrom: now, updatedAt: new Date() })
    .where(eq(users.wallet, wallet))
    .returning({ id: users.id })

  // Evict rather than write the new value: the read path is the only
  // thing that should populate the cache, and this guarantees the very
  // next check sees committed state.
  forgetRevocation(wallet)

  return !!row
}
