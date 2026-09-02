/**
 * NONCE SERVICE (WAGERING_IMPLEMENTATION.md §4.1)
 * ===============================================
 * One-time nonces for the deposit and gift flows. Reuses the existing
 * `nonces` table (the auth challenge store — same shape, same atomic
 * consume pattern, and UUID values make cross-flow collisions impossible;
 * the worst a nonce fed to the wrong flow can do is burn ITSELF).
 *
 * The consume is a single conditional UPDATE — the §4.1 contract forbids
 * select-then-update because two concurrent confirms carrying the same
 * nonce must resolve to exactly one winner, decided by the database.
 */

import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm'
import { db } from '../db'
import { nonces } from '../db/schema'

/** Deposit/gift nonces live 2 minutes (§4.1). */
const NONCE_TTL_MS = 2 * 60 * 1000

/** Expired-row cleanup cadence (hourly per spec). */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
let lastCleanupAt = 0

/**
 * Issue a fresh nonce bound to `wallet`. Throws if the DB is missing —
 * money flows refuse to run without a ledger (routes 503 before this).
 */
export async function issueNonce(wallet: string): Promise<string> {
  if (!db) throw new Error('no database — wagering requires DATABASE_URL')

  // Opportunistic hourly cleanup, piggybacked on issuance so there is no
  // separate timer to manage (used rows are kept until they EXPIRE —
  // deleting a used nonce early would let its uuid be re-issued in theory).
  const now = Date.now()
  if (now - lastCleanupAt > CLEANUP_INTERVAL_MS) {
    lastCleanupAt = now
    await db.delete(nonces).where(lte(nonces.expiresAt, sql`now()`))
  }

  const nonce = crypto.randomUUID()
  await db.insert(nonces).values({
    nonce,
    wallet,
    expiresAt: new Date(now + NONCE_TTL_MS),
  })
  return nonce
}

/**
 * Atomically consume a nonce for `wallet`. True iff THIS call was the one
 * that spent it: unused, unexpired, and bound to the same wallet. One
 * statement, one winner — no select-then-update (§4.1, verbatim rule).
 */
export async function consumeNonce(
  nonce: string,
  wallet: string
): Promise<boolean> {
  if (!db) return false

  const consumed = await db
    .update(nonces)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(nonces.nonce, nonce),
        eq(nonces.wallet, wallet),
        isNull(nonces.usedAt),
        gt(nonces.expiresAt, sql`now()`)
      )
    )
    .returning({ nonce: nonces.nonce })

  return consumed.length === 1
}
