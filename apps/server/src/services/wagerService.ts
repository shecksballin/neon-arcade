/**
 * WAGER SERVICE — all free-play pot mutations live HERE and nowhere else
 * ======================================================================
 * Implements the atomic money patterns from
 * `permanentSever, regions, atomic money patterns .md` §6:
 *
 *   Pattern 1 — atomic claim before payout           → cashOut()
 *   Pattern 3 — SQL-level arithmetic (no read+write) → onKill() credits
 *   Pattern 5 — one active session per wallet        → joinFreeplay()
 *                (enforced by the partial unique index in db/schema.ts)
 *   Pattern 6 — kill resolution is ONE transaction   → onKill()
 *   Pattern 7 — idempotent payouts (payouts rows,    → cashOut(),
 *                stranded 'cashing_out' rows are       onEnvironmentKill()
 *                surfaced, never auto-retried)
 *
 * PRINCIPLE (§6): the database is the ONLY source of truth for money.
 * In-memory pot values inside the world loop are a render cache; every
 * settlement here reads/mutates Neon at the moment of the operation.
 * Regions are separate processes sharing one Neon DB, so every guard in
 * this file must hold across concurrent server instances — which is why
 * the guards are SQL (status checks, row locks, unique indexes), never
 * JS-side "I checked a moment ago" logic.
 *
 * MONEY REPRESENTATION
 * --------------------
 * All money columns are Postgres numeric(18, 9) — drizzle maps them to
 * decimal STRINGS in TS. Arithmetic that must be race-free happens in SQL
 * (`sql\`${col} + ${x}\``). The only JS arithmetic is the fee SPLIT of a
 * value we hold a row lock on; JS doubles represent nine-decimal SOL
 * amounts exactly up to ~9 million SOL (2^53 / 1e9), far beyond any pot,
 * and results are re-quantized to 9 decimals before hitting SQL.
 *
 * ON-CHAIN: none in this pass. Deposits are ledger stubs and payouts are
 * DB rows with txSig = null. // TODO(on-chain): wire real transfers.
 *
 * NULL-DB / ERROR POLICY: every export returns null when `db` is null and
 * NEVER throws into callers (world loops call these mid-tick). Free play
 * REFUSES to run without a DB — the socket layer maps a null from
 * ensureFreeplayMatch/joinFreeplay to `freeplay:error { code:'no_db' }`.
 */

import { and, asc, eq, sql } from 'drizzle-orm'
import { config } from '../config/env'
import { db } from '../db'
import { matches, matchPlayers, payouts } from '../db/schema'

type MatchRow = typeof matches.$inferSelect
type MatchPlayerRow = typeof matchPlayers.$inferSelect

// ─────────────────────────────────────────────────
// Money helpers — numeric(18, 9) ⇄ JS
// ─────────────────────────────────────────────────

/** Scale of every money column: nine decimals (lamport precision). */
const MONEY_SCALE = 9

/** Format a JS number as a scale-9 decimal string for a numeric column. */
function sol(n: number): string {
  return n.toFixed(MONEY_SCALE)
}

/** Re-quantize a JS float to exactly 9 decimals so a fee split always
 *  satisfies killerGets + houseTakes === victimPot to the digit. */
function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9
}

/** Postgres unique-violation (SQLSTATE 23505) — how Pattern 5's partial
 *  index announces a double-join. Checked by code AND by message so it
 *  still works if a driver wraps the error. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  return (
    e?.code === '23505' ||
    /one_active_session_per_wallet|duplicate key/i.test(String(e?.message ?? ''))
  )
}

// ─────────────────────────────────────────────────
// Permanent match row
// ─────────────────────────────────────────────────

/**
 * Find-or-create the ONE permanent matches row for (game, region).
 * Called lazily when a world instance spins up. The row never settles —
 * it exists so matchPlayers/payouts/eloHistory have a matchId to hang off.
 *
 * Race note: two instances of the same (game, region) could insert
 * concurrently (there is no unique index on the triple). We converge by
 * ALWAYS re-selecting the OLDEST active row after inserting — every caller
 * lands on the same winner, and a stray duplicate row simply never gets
 * players attached.
 */
export async function ensureFreeplayMatch(
  game: string,
  region: string,
  entryFee: number = config.FREEPLAY_ENTRY_FEE
): Promise<MatchRow | null> {
  if (!db) return null // free play refuses to run without a ledger

  try {
    const find = () =>
      db!
        .select()
        .from(matches)
        .where(
          and(
            eq(matches.gameId, game),
            eq(matches.gameMode, 'freeplay'),
            eq(matches.region, region),
            eq(matches.status, 'active')
          )
        )
        .orderBy(asc(matches.createdAt)) // oldest wins — see race note
        .limit(1)

    const [existing] = await find()
    if (existing) return existing

    // Not found → create it. betAmount records the entry fee snapshot.
    await db.insert(matches).values({
      gameId: game,
      mode: 'ffa',
      gameMode: 'freeplay',
      status: 'active',
      region,
      betAmount: sol(entryFee),
    })

    // Re-select instead of trusting our own insert: if another instance
    // inserted in the same instant, both converge on the oldest row.
    const [row] = await find()
    return row ?? null
  } catch (err) {
    console.error('[wagerService] ensureFreeplayMatch failed:', err)
    return null
  }
}

// ─────────────────────────────────────────────────
// Join (Pattern 5)
// ─────────────────────────────────────────────────

/** Discriminated result so the socket layer can answer precisely. */
export type JoinFreeplayResult =
  | { player: MatchPlayerRow }
  | { error: 'already_active' }
  | null

/**
 * Register a wallet in the permanent match with its entry fee as the
 * starting pot.
 *
 * TODO(on-chain): deposit verification. This pass CREDITS the entry fee as
 * a pure ledger stub — no SOL moves anywhere.
 *
 * Pattern 5: we do NOT pre-check "is this wallet already playing?" in JS —
 * that check would race across regions. We just insert; the partial unique
 * index `one_active_session_per_wallet` (wallet WHERE status='active')
 * rejects a second active session ANYWHERE, and we translate that DB error
 * into `{ error: 'already_active' }`. The database is the bouncer.
 */
export async function joinFreeplay(
  matchId: string,
  wallet: string,
  entryFee: number = config.FREEPLAY_ENTRY_FEE
): Promise<JoinFreeplayResult> {
  if (!db) return null // socket layer maps this to freeplay:error no_db

  try {
    const fee = sol(entryFee)
    const [player] = await db
      .insert(matchPlayers)
      .values({
        matchId,
        wallet,
        status: 'active',
        depositSol: fee, // TODO(on-chain): verified deposit amount
        currentPot: fee,
      })
      .returning()
    return player ? { player } : null
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Second active session for this wallet (possibly another region).
      return { error: 'already_active' }
    }
    console.error('[wagerService] joinFreeplay failed:', err)
    return null
  }
}

// ─────────────────────────────────────────────────
// Kill resolution (Patterns 3 + 6)
// ─────────────────────────────────────────────────

export interface KillResult {
  /** What the killer's pot was credited (victim pot minus house fee). */
  killerGets: string
  /** House fee taken from the victim's pot. */
  houseTakes: string
  /** The victim's pot at the moment of death (what was at stake). */
  victimPot: string
  /** Killer's pot AFTER the credit — for the `freeplay:pot` event. */
  killerPot: string
  /** Killer's kill count AFTER the increment. */
  killerKills: number
}

/**
 * Resolve a player-vs-player kill. ONE transaction (Pattern 6): the victim
 * reset, the killer credit, and the house cut all commit together or not
 * at all — a crash mid-kill can never mint or destroy money.
 *
 * Atomicity walk-through:
 *  1. Both rows are locked with SELECT ... FOR UPDATE, acquired in sorted-
 *     wallet order so two simultaneous kills involving the same players
 *     (A kills B while B kills A on adjacent ticks) queue up instead of
 *     deadlocking.
 *  2. The victim lock carries a status='active' guard: if the victim
 *     already cashed out / was eliminated / was killed by someone faster,
 *     the SELECT comes back empty and we abort with NO mutations — the
 *     "two killers, one victim" race pays exactly one killer.
 *  3. The fee split is computed in JS from the LOCKED victim pot (safe:
 *     nobody can change it until we commit), but the killer credit is SQL
 *     arithmetic (Pattern 3) — `current_pot + x` — because the killer's
 *     own pot is NOT otherwise protected against concurrent credits from
 *     other kills landing in other transactions.
 *  4. Victim respawns rich-in-spirit only: pot reset to the entry fee,
 *     status STAYS 'active' (doc §4 — kills and session persist across
 *     respawn), eliminatedBy records the killer for the kill feed.
 *
 * Returns the amounts (decimal strings) or null if the kill could not be
 * settled (victim/killer no longer active, no db, any error) — the world
 * should then skip the kill's money/ELO effects.
 */
export async function onKill(
  matchId: string,
  killerWallet: string,
  victimWallet: string,
  entryFee: number = config.FREEPLAY_ENTRY_FEE
): Promise<KillResult | null> {
  if (!db) return null
  if (killerWallet === victimWallet) return null // self-kill is not a payday

  try {
    return await db.transaction(async (tx) => {
      // Lock helper: the row is only interesting while status='active'.
      const lockActive = (wallet: string) =>
        tx
          .select()
          .from(matchPlayers)
          .where(
            and(
              eq(matchPlayers.matchId, matchId),
              eq(matchPlayers.wallet, wallet),
              eq(matchPlayers.status, 'active')
            )
          )
          .for('update')

      // Sorted acquisition order — see atomicity walk-through step 1.
      const locked = new Map<string, MatchPlayerRow | undefined>()
      for (const wallet of [killerWallet, victimWallet].sort()) {
        locked.set(wallet, (await lockActive(wallet))[0])
      }
      const killer = locked.get(killerWallet)
      const victim = locked.get(victimWallet)

      // Victim gone → already settled by someone/something else (step 2).
      // Killer gone → they cashed out or died in the same instant; abort
      // with no mutations rather than credit a closed session. The tx
      // commits as a no-op (locks only), which is fine.
      if (!victim || !killer) return null

      // Fee split from the locked victim pot (see header for precision).
      const victimPotNum = Number(victim.currentPot)
      const houseTakesNum = round9((victimPotNum * config.HOUSE_FEE_PERCENT) / 100)
      const killerGetsNum = round9(victimPotNum - houseTakesNum)

      // Victim: pot back to entry fee, still 'active' (they respawn).
      // The status guard is kept even though we hold the lock — belt and
      // braces, and it documents the invariant in the query itself.
      await tx
        .update(matchPlayers)
        .set({
          currentPot: sol(entryFee),
          eliminatedBy: killerWallet, // kill-feed bookkeeping ("last death")
        })
        .where(
          and(eq(matchPlayers.id, victim.id), eq(matchPlayers.status, 'active'))
        )

      // Killer: credit + kill count via SQL arithmetic (Pattern 3) — a
      // single atomic statement, no read-modify-write window.
      const [killerAfter] = await tx
        .update(matchPlayers)
        .set({
          currentPot: sql`${matchPlayers.currentPot} + ${sol(killerGetsNum)}`,
          kills: sql`${matchPlayers.kills} + 1`,
        })
        .where(
          and(eq(matchPlayers.id, killer.id), eq(matchPlayers.status, 'active'))
        )
        .returning()
      if (!killerAfter) {
        // "Can't happen" under the lock — but if it does, throwing rolls
        // back the ENTIRE transaction including the victim reset (Pattern 6).
        throw new Error('killer row disappeared mid-kill')
      }

      // House cut accumulates on the permanent match row (SQL arithmetic
      // again — many kills across the region land on this one row).
      await tx
        .update(matches)
        .set({ houseTotal: sql`${matches.houseTotal} + ${sol(houseTakesNum)}` })
        .where(eq(matches.id, matchId))

      return {
        killerGets: sol(killerGetsNum),
        houseTakes: sol(houseTakesNum),
        victimPot: victim.currentPot,
        killerPot: killerAfter.currentPot,
        killerKills: killerAfter.kills,
      }
    })
  } catch (err) {
    console.error('[wagerService] onKill failed:', err)
    return null
  }
}

// ─────────────────────────────────────────────────
// Environment kill (doc §4 — house takes all, no respawn)
// ─────────────────────────────────────────────────

/**
 * A player died to the environment (asteroid collision). The house takes
 * the FULL pot (no fee split), the session ends with status='eliminated',
 * and there is NO respawn — the world despawns them for good.
 *
 * Same transactional shape as onKill: lock-with-guard, then mutate. The
 * status='active' claim means a cash-out racing this death settles exactly
 * one way — whichever statement wins the lock; the loser sees a non-active
 * row and aborts.
 *
 * A payouts row (type 'house', txSig null) is written as the audit trail
 * for the sweep, so every SOL that leaves a player pot is accounted for in
 * one table.
 */
export async function onEnvironmentKill(
  matchId: string,
  wallet: string
): Promise<{ potLost: string } | null> {
  if (!db) return null

  try {
    return await db.transaction(async (tx) => {
      // Lock + claim guard: only an 'active' session can be eliminated.
      const [victim] = await tx
        .select()
        .from(matchPlayers)
        .where(
          and(
            eq(matchPlayers.matchId, matchId),
            eq(matchPlayers.wallet, wallet),
            eq(matchPlayers.status, 'active')
          )
        )
        .for('update')
      if (!victim) return null // already cashed out / eliminated / killed

      const potLost = victim.currentPot

      // Terminal state: eliminated, pot zeroed. This also FREES the partial
      // unique index (Pattern 5) so the wallet can join a fresh session.
      await tx
        .update(matchPlayers)
        .set({
          status: 'eliminated',
          currentPot: sol(0),
          eliminatedBy: 'environment',
        })
        .where(eq(matchPlayers.id, victim.id))

      // Full pot to the house — no fee split on environment deaths (§4).
      await tx
        .update(matches)
        .set({ houseTotal: sql`${matches.houseTotal} + ${potLost}` })
        .where(eq(matches.id, matchId))

      // Audit row: where the pot went. txSig stays null (no chain).
      await tx.insert(payouts).values({
        matchId,
        wallet,
        amountSol: potLost,
        type: 'house',
        txSig: null, // TODO(on-chain): house sweep transfer signature
      })

      return { potLost }
    })
  } catch (err) {
    console.error('[wagerService] onEnvironmentKill failed:', err)
    return null
  }
}

// ─────────────────────────────────────────────────
// Cash out (Patterns 1 + 7)
// ─────────────────────────────────────────────────

/**
 * Cash a player out at their current pot. Used by the 3-second hold, the
 * disconnect-grace timeout, voluntary leave, and graceful shutdown.
 *
 * Pattern 1 — atomic claim BEFORE payout, in three separate steps ON
 * PURPOSE (do not collapse into one transaction once real SOL moves):
 *
 *  1. CLAIM: status 'active' → 'cashing_out' with the status guard in the
 *     WHERE clause. UPDATE...RETURNING is a single atomic statement, so
 *     exactly ONE caller can win this — even against a kill or a second
 *     cash-out racing from another region. The RETURNING row snapshots the
 *     pot at claim time (the claim doesn't touch currentPot).
 *  2. PAYOUT: // TODO(on-chain) — this is where the SOL transfer will go.
 *     Today it is a payouts row with txSig = null.
 *  3. FINALIZE: status → 'cashed_out', pot → 0. Frees the Pattern-5 index
 *     so the wallet can rejoin later.
 *
 * Pattern 7: if the process dies between claim and finalize, the row is
 * left in 'cashing_out' — deliberately. That stranded state is DETECTABLE
 * (a query for stale cashing_out rows surfaces it for manual review) and
 * is never auto-retried, because once real payouts exist the SOL may
 * already have been sent. Silent double-pay is the failure mode this
 * shape exists to prevent.
 *
 * Returns { payout, kills } on success; null if there was nothing to claim
 * (not active — already dead/cashed out) or on any failure.
 */
export async function cashOut(
  matchId: string,
  wallet: string
): Promise<{ payout: string; kills: number } | null> {
  if (!db) return null

  try {
    // Step 1 — the atomic claim. Only one winner, ever.
    const [claimed] = await db
      .update(matchPlayers)
      .set({ status: 'cashing_out' }) // intermediate, crash-detectable state
      .where(
        and(
          eq(matchPlayers.matchId, matchId),
          eq(matchPlayers.wallet, wallet),
          eq(matchPlayers.status, 'active') // ← the guard
        )
      )
      .returning()
    if (!claimed) return null // lost the race, or nothing to cash out

    // Step 2 — TODO(on-chain): send `claimed.currentPot` SOL to `wallet`
    // here and capture the real txSig for the payouts row below.

    // Steps 2b+3 — ledger row + finalize together: with no real transfer
    // yet, these can share a transaction so the books and the terminal
    // state land as one unit.
    await db.transaction(async (tx) => {
      await tx.insert(payouts).values({
        matchId,
        wallet,
        amountSol: claimed.currentPot,
        type: 'cashout',
        txSig: null, // TODO(on-chain): real transaction signature
      })
      await tx
        .update(matchPlayers)
        .set({ status: 'cashed_out', currentPot: sol(0) })
        .where(eq(matchPlayers.id, claimed.id))
    })

    return { payout: claimed.currentPot, kills: claimed.kills }
  } catch (err) {
    // If the finalize failed AFTER a successful claim, the row is now
    // stranded in 'cashing_out' — that is the Pattern 7 tripwire, left for
    // manual review. We still must not throw into the world loop.
    console.error('[wagerService] cashOut failed:', err)
    return null
  }
}

// ─────────────────────────────────────────────────
// Lookups
// ─────────────────────────────────────────────────

/**
 * The wallet's active session row in a match, or null. Used by the world
 * for reconnect-resume (grace window) and to hydrate pots after a restart.
 * Read-only — no lock; anything money-mutating must NOT trust this
 * snapshot and must re-guard in SQL (see every mutation above).
 */
export async function getActivePlayerRow(
  matchId: string,
  wallet: string
): Promise<MatchPlayerRow | null> {
  if (!db) return null

  try {
    const [row] = await db
      .select()
      .from(matchPlayers)
      .where(
        and(
          eq(matchPlayers.matchId, matchId),
          eq(matchPlayers.wallet, wallet),
          eq(matchPlayers.status, 'active')
        )
      )
      .limit(1)
    return row ?? null
  } catch (err) {
    console.error('[wagerService] getActivePlayerRow failed:', err)
    return null
  }
}
