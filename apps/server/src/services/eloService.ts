/**
 * ELO SERVICE
 * ===========
 * The ONLY place ratings are mutated. Three settlement paths (handoff §6,
 * design contract "ELO service" section):
 *
 *   settle1v1     — K=32 on users.elo    (chess / connect / volley / quiz 1v1)
 *   settleFfa     — K=16 on users.eloFfa (quiz FFA — placement-based)
 *   freeplayKill  — K=12 on users.eloFfa (cells / asteroids — per kill)
 *
 * All three use the standard expected score E = 1 / (1 + 10^((them-me)/400)).
 *
 * ATOMICITY REASONING
 * -------------------
 * Ratings are read-modify-write: we must read the current ratings to compute
 * the expected score, then write deltas. Two settlements touching the same
 * wallet at once (e.g. a chess game and a volley game ending in the same
 * second) would race a naive read-then-write. So every path:
 *   1. runs in ONE transaction,
 *   2. locks the affected users rows with SELECT ... FOR UPDATE, acquired in
 *      a consistent order (sorted by wallet) so two concurrent settlements
 *      can never deadlock each other,
 *   3. applies the delta with SQL-level arithmetic (`greatest(0, elo + d)`)
 *      per the design contract — the floor lives in the same atomic
 *      statement as the addition,
 *   4. writes eloHistory rows with before/after computed under the lock, so
 *      history always satisfies before + change === after.
 *
 * ELO floor is 0, not the handoff's "100" — the handoff's own rank table
 * starts Copper at 0 and the schema default is 0, so 0 wins (per contract).
 *
 * NULL-DB / ERROR POLICY
 * ----------------------
 * Every export returns null when `db` is null (server runs without a
 * database; games still play, ratings just don't persist) and NEVER throws
 * into callers — game loops and disconnect handlers call these
 * fire-and-forget. Failures are console.error'd and swallowed.
 */

import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import { eloHistory, users } from '../db/schema'

// K-factors pinned by the design contract (handoff §6).
const K_1V1 = 32
const K_FFA = 16
const K_FREEPLAY = 12

// FFA answer window scoring: linear placement score S = (n - p) / (n - 1),
// so 1st place → 1.0 and last place → 0.0, compared against the expected
// score vs the field-average rating.

type DbClient = NonNullable<typeof db>
// The transaction handle type, derived from db.transaction's callback so we
// don't have to name drizzle's internal generics.
type Tx = Parameters<Parameters<DbClient['transaction']>[0]>[0]
type UserRow = typeof users.$inferSelect
type HistoryInsert = typeof eloHistory.$inferInsert

/** Rating snapshot AFTER settlement — shaped for `newRatings` payloads. */
export interface RatingAfter {
  name: string
  rating: number
  change: number
}

export interface Settle1v1Result {
  a: RatingAfter
  b: RatingAfter
}

/**
 * One FFA participant's post-settlement rating. NOTE: `wallet` is included
 * for the HANDLER's own bookkeeping only — strip it before broadcasting to
 * a room (global rule: never leak wallets to opponents).
 */
export interface FfaRatingResult {
  wallet: string
  name: string
  rating: number
  change: number
  placement: number
}

export interface FreeplayKillResult {
  killer: RatingAfter
  victim: RatingAfter
}

/** One FFA standing as reported by the game handler (higher score = better).
 *  `kills` is optional bookkeeping for eloHistory — quiz FFA passes correct
 *  answers here (handoff §6: "correct answers substitute kills"). */
export interface FfaStanding {
  wallet: string
  score: number
  kills?: number
}

/** Standard ELO expected score for `me` against `them`. */
function expectedScore(me: number, them: number): number {
  return 1 / (1 + Math.pow(10, (them - me) / 400))
}

/**
 * Lock the users rows for `wallets` inside a transaction.
 * ORDER BY wallet makes every caller acquire row locks in the same global
 * order — the classic deadlock-avoidance trick when two transactions touch
 * overlapping row sets concurrently.
 */
async function lockUserRows(tx: Tx, wallets: string[]): Promise<UserRow[]> {
  return tx
    .select()
    .from(users)
    .where(inArray(users.wallet, wallets))
    .orderBy(asc(users.wallet))
    .for('update')
}

/**
 * Apply a rating delta with the floor INSIDE the SQL statement.
 * `greatest(0, col + delta)` is a single atomic expression — no window where
 * a concurrent writer could observe (or clobber) an intermediate value.
 * Because the caller holds the row lock, the JS-computed "after" value
 * (max(0, before + delta)) is guaranteed to match what this writes.
 */
async function applyRatingDelta(
  tx: Tx,
  wallet: string,
  column: 'elo' | 'eloFfa',
  delta: number
): Promise<void> {
  const patch =
    column === 'elo'
      ? { elo: sql`greatest(0, ${users.elo} + ${delta})` }
      : { eloFfa: sql`greatest(0, ${users.eloFfa} + ${delta})` }
  await tx.update(users).set(patch).where(eq(users.wallet, wallet))
}

/** Placement multiplier per the design contract:
 *  1st = 2.0, top 10% = 1.5, top 25% = 1.2, everyone else = 1.0. */
function placementMultiplier(placement: number, fieldSize: number): number {
  if (placement === 1) return 2.0
  if (placement <= Math.max(1, Math.ceil(fieldSize * 0.1))) return 1.5
  if (placement <= Math.max(1, Math.ceil(fieldSize * 0.25))) return 1.2
  return 1.0
}

/**
 * Settle a finished 1v1 game. K=32 on users.elo. Draws are S=0.5 for both
 * (per contract — NOT skipped like the old reference server did).
 *
 * `result`: 'a' = aWallet won, 'b' = bWallet won, 'draw' = split.
 * `matchId` is optional — 1v1 games don't create matches rows in this pass,
 * so eloHistory.matchId stays null for them.
 *
 * Returns after-ratings for the `newRatings` payload, or null (no db /
 * missing users rows / any failure).
 */
export async function settle1v1(
  gameKey: string,
  aWallet: string,
  bWallet: string,
  result: 'a' | 'b' | 'draw',
  matchId: string | null = null
): Promise<Settle1v1Result | null> {
  if (!db) return null // no database → games still play, ratings skipped
  if (aWallet === bWallet) return null // self-play can't be rated

  try {
    return await db.transaction(async (tx) => {
      // Lock both rows (sorted order → no deadlocks with concurrent settles).
      const rows = await lockUserRows(tx, [aWallet, bWallet])
      const a = rows.find((r) => r.wallet === aWallet)
      const b = rows.find((r) => r.wallet === bWallet)
      if (!a || !b) {
        // Games require registered accounts, so this "can't happen" — but a
        // missing row must not throw into the game handler.
        console.error('[eloService] settle1v1: missing users row(s)', { gameKey })
        return null
      }

      // Actual scores: win = 1, loss = 0, draw = 0.5 each.
      const sA = result === 'a' ? 1 : result === 'b' ? 0 : 0.5
      const sB = 1 - sA

      // Expected scores from CURRENT (locked) ratings.
      const eA = expectedScore(a.elo, b.elo)
      const eB = 1 - eA

      // Round each delta independently — Math.round(-x) !== -Math.round(x)
      // at .5 boundaries, and each player's ledger should be self-consistent.
      const deltaA = Math.round(K_1V1 * (sA - eA))
      const deltaB = Math.round(K_1V1 * (sB - eB))

      // The floor can clamp: eloChange is derived from the FLOORED after
      // value so history always satisfies before + change === after.
      const afterA = Math.max(0, a.elo + deltaA)
      const afterB = Math.max(0, b.elo + deltaB)

      await applyRatingDelta(tx, aWallet, 'elo', deltaA)
      await applyRatingDelta(tx, bWallet, 'elo', deltaB)

      const history: HistoryInsert[] = [
        {
          matchId,
          wallet: aWallet,
          gameKey,
          mode: '1v1',
          eloBefore: a.elo,
          eloAfter: afterA,
          eloChange: afterA - a.elo,
        },
        {
          matchId,
          wallet: bWallet,
          gameKey,
          mode: '1v1',
          eloBefore: b.elo,
          eloAfter: afterB,
          eloChange: afterB - b.elo,
        },
      ]
      await tx.insert(eloHistory).values(history)

      return {
        a: { name: a.username ?? 'Player', rating: afterA, change: afterA - a.elo },
        b: { name: b.username ?? 'Player', rating: afterB, change: afterB - b.elo },
      }
    })
  } catch (err) {
    console.error('[eloService] settle1v1 failed:', err)
    return null
  }
}

/**
 * Settle a finished FFA game (quiz FFA). K=16 on users.eloFfa.
 *
 * Model (per contract): each player's actual score is their linear placement
 * score S = (n - placement) / (n - 1); their expected score E is computed
 * against the FIELD-AVERAGE rating of the other participants; the delta is
 * K * placementMultiplier * (S - E), floored at 0 total rating.
 *
 * Placement uses competition ranking (1 + count of strictly better scores),
 * so tied scores share a placement. Placements are computed over the FULL
 * standings; the rating field-average only over wallets that actually have
 * a users row (unrated wallets can't move, and shouldn't skew the average).
 *
 * Returns one entry per RATED participant, sorted by placement — strip
 * `wallet` before broadcasting.
 */
export async function settleFfa(
  gameKey: string,
  standings: FfaStanding[],
  matchId: string | null = null
): Promise<FfaRatingResult[] | null> {
  if (!db) return null
  if (standings.length < 2) return null // no opponents → nothing to rate

  try {
    return await db.transaction(async (tx) => {
      // Sort once, best score first (defensive — don't trust caller order).
      const sorted = [...standings].sort((x, y) => y.score - x.score)
      const n = sorted.length

      // Competition ranking: placement = 1 + (# players strictly better).
      const placementOf = new Map<string, number>()
      for (const s of sorted) {
        placementOf.set(s.wallet, 1 + sorted.filter((o) => o.score > s.score).length)
      }

      // Lock every participant's users row (sorted acquisition, see helper).
      const rows = await lockUserRows(tx, sorted.map((s) => s.wallet))
      const byWallet = new Map(rows.map((r) => [r.wallet, r]))

      const rated = sorted.filter((s) => byWallet.has(s.wallet))
      if (rated.length < 2) return null // need 2+ rated players for a field

      const totalRating = rated.reduce(
        (sum, s) => sum + byWallet.get(s.wallet)!.eloFfa,
        0
      )

      const results: FfaRatingResult[] = []
      const history: HistoryInsert[] = []

      for (const s of rated) {
        const u = byWallet.get(s.wallet)!
        const placement = placementOf.get(s.wallet)!

        // Expected score vs the average rating of everyone else in the field.
        const avgOthers = (totalRating - u.eloFfa) / (rated.length - 1)
        const e = expectedScore(u.eloFfa, avgOthers)

        // Actual score from placement: 1st → 1.0 ... last → 0.0.
        const sActual = (n - placement) / (n - 1)

        const mult = placementMultiplier(placement, n)
        const delta = Math.round(K_FFA * mult * (sActual - e))
        const after = Math.max(0, u.eloFfa + delta) // floor 0, see header

        await applyRatingDelta(tx, s.wallet, 'eloFfa', delta)

        history.push({
          matchId,
          wallet: s.wallet,
          gameKey,
          mode: 'ffa',
          eloBefore: u.eloFfa,
          eloAfter: after,
          eloChange: after - u.eloFfa,
          kills: s.kills ?? 0, // quiz FFA: correct answers stand in for kills
          placement,
        })
        results.push({
          wallet: s.wallet,
          name: u.username ?? 'Player',
          rating: after,
          change: after - u.eloFfa,
          placement,
        })
      }

      await tx.insert(eloHistory).values(history)
      return results
    })
  } catch (err) {
    console.error('[eloService] settleFfa failed:', err)
    return null
  }
}

/**
 * Incremental per-kill ELO for free play (cells/asteroids). K=12 on
 * users.eloFfa, single-kill expected score (killer S=1, victim S=0).
 * No placement — there is no match end in a permanent world.
 *
 * Designed to be called FIRE-AND-FORGET from the world tick loop (do NOT
 * await it in the tick): it never throws, and a lost update on failure is
 * acceptable for ratings (unlike money — see wagerService).
 *
 * `gameKey` defaults to 'freeplay'; worlds should pass 'cells'/'asteroids'.
 * `matchId` should be the permanent freeplay match row id when available.
 */
export async function freeplayKill(
  killerWallet: string,
  victimWallet: string,
  gameKey: string = 'freeplay',
  matchId: string | null = null
): Promise<FreeplayKillResult | null> {
  if (!db) return null
  if (killerWallet === victimWallet) return null

  try {
    return await db.transaction(async (tx) => {
      const rows = await lockUserRows(tx, [killerWallet, victimWallet])
      const killer = rows.find((r) => r.wallet === killerWallet)
      const victim = rows.find((r) => r.wallet === victimWallet)
      if (!killer || !victim) {
        console.error('[eloService] freeplayKill: missing users row(s)', { gameKey })
        return null
      }

      // Killer scored 1, victim scored 0; round independently (see settle1v1).
      const eK = expectedScore(killer.eloFfa, victim.eloFfa)
      const eV = 1 - eK
      const deltaK = Math.round(K_FREEPLAY * (1 - eK))
      const deltaV = Math.round(K_FREEPLAY * (0 - eV))

      const afterK = Math.max(0, killer.eloFfa + deltaK)
      const afterV = Math.max(0, victim.eloFfa + deltaV)

      await applyRatingDelta(tx, killerWallet, 'eloFfa', deltaK)
      await applyRatingDelta(tx, victimWallet, 'eloFfa', deltaV)

      const history: HistoryInsert[] = [
        {
          matchId,
          wallet: killerWallet,
          gameKey,
          mode: 'freeplay',
          eloBefore: killer.eloFfa,
          eloAfter: afterK,
          eloChange: afterK - killer.eloFfa,
          kills: 1,
        },
        {
          matchId,
          wallet: victimWallet,
          gameKey,
          mode: 'freeplay',
          eloBefore: victim.eloFfa,
          eloAfter: afterV,
          eloChange: afterV - victim.eloFfa,
          kills: 0,
        },
      ]
      await tx.insert(eloHistory).values(history)

      return {
        killer: {
          name: killer.username ?? 'Player',
          rating: afterK,
          change: afterK - killer.eloFfa,
        },
        victim: {
          name: victim.username ?? 'Player',
          rating: afterV,
          change: afterV - victim.eloFfa,
        },
      }
    })
  } catch (err) {
    console.error('[eloService] freeplayKill failed:', err)
    return null
  }
}
