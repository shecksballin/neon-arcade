/**
 * WAGER ENGINE (WAGERING_IMPLEMENTATION.md §6)
 * ============================================
 * ALL money math for real-SOL wager matches lives here. Game modules call
 * these functions; nothing else touches pots. (Free play keeps its own
 * ledger-only wagerService — different rules: respawns, permanent rows,
 * no chain.)
 *
 * Every mutation follows §7 verbatim:
 *   claim-before-pay · SQL arithmetic · guarded victim updates ·
 *   row locks for read-modify-write · no auto-retry of failed sends.
 *
 * FEES, exactly as specified: a kill-steal pays the killer
 * victimPot×(1−fee), AND the final settlement pays the winner
 * currentPot×(1−fee) — the fee applies at both steps by §6.1/§6.2's
 * explicit formulas. That double application on stolen value is the
 * documented contract, not an accident; changing it is an owner decision.
 */

import { and, eq, sql } from 'drizzle-orm'
import { config } from '../config/env'
import { db } from '../db'
import { matches, matchPlayers, payouts } from '../db/schema'
import { sendPayout } from '../solana/payoutService'
import { alert } from './alertService'

type MatchPlayerRow = typeof matchPlayers.$inferSelect

// ─────────────────────────────────────────────────
// Money helpers (same conventions as wagerService)
// ─────────────────────────────────────────────────

const feeFraction = () => config.HOUSE_FEE_PERCENT / 100

function sol(n: number): string {
  return n.toFixed(9)
}

function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9
}

function requireDbOrThrow() {
  if (!db) throw new Error('no database — the wager engine requires a ledger')
  return db
}

// ─────────────────────────────────────────────────
// §6.1 resolveKill
// ─────────────────────────────────────────────────

export type KillReason = 'combat' | 'zone' | 'asteroid'

export interface ResolveKillOpts {
  matchId: string
  /** How this game mode treats a kill's money. */
  mode: 'steal' | 'accumulate'
  /** null = environment kill (reason says which environment). */
  killer: string | null
  victim: string
  reason: KillReason
}

export type ResolveKillOutcome =
  | {
      ok: true
      killerPot: string | null
      killerKills: number | null
      victimPot: string
    }
  | { ok: false; error: 'victim_not_active' | 'killer_not_active' | 'rejected' }

/**
 * Settle one kill. ONE transaction; the victim update carries
 * status='active' in its WHERE and the whole thing aborts if no row was
 * affected (§6.1: a concurrent kill already landed).
 */
export async function resolveKill(
  opts: ResolveKillOpts
): Promise<ResolveKillOutcome> {
  const dbh = requireDbOrThrow()
  if (opts.killer === opts.victim) return { ok: false, error: 'rejected' }

  return dbh.transaction(async (tx) => {
    // Lock the victim's ACTIVE row; sorted-with-killer order below mirrors
    // wagerService.onKill's deadlock avoidance.
    const lockActive = (wallet: string) =>
      tx
        .select()
        .from(matchPlayers)
        .where(
          and(
            eq(matchPlayers.matchId, opts.matchId),
            eq(matchPlayers.wallet, wallet),
            eq(matchPlayers.status, 'active')
          )
        )
        .for('update')

    const walletsToLock = [opts.victim, ...(opts.killer ? [opts.killer] : [])]
    const locked = new Map<string, MatchPlayerRow | undefined>()
    for (const w of [...walletsToLock].sort()) {
      locked.set(w, (await lockActive(w))[0])
    }

    const victim = locked.get(opts.victim)
    if (!victim) return { ok: false as const, error: 'victim_not_active' as const }
    const killer = opts.killer ? locked.get(opts.killer) : null
    if (opts.killer && !killer) {
      return { ok: false as const, error: 'killer_not_active' as const }
    }

    const victimPotNum = Number(victim.currentPot)

    // Victim: eliminated, pot zeroed, ordering stamp for slayer ranks.
    // Guard kept in the WHERE despite the lock (§7.5 — belt and braces);
    // an affected-count of zero aborts everything.
    const eliminated = await tx
      .update(matchPlayers)
      .set({
        status: 'eliminated',
        currentPot: sol(0),
        eliminatedBy: opts.killer ?? 'environment',
        eliminatedAt: sql`now()`,
      })
      .where(
        and(eq(matchPlayers.id, victim.id), eq(matchPlayers.status, 'active'))
      )
      .returning({ id: matchPlayers.id })
    if (eliminated.length !== 1) {
      throw new Error('victim row vanished under lock — aborting kill')
    }

    // ENVIRONMENT kill: house takes the full pot (§6.1). No killer credit.
    if (!opts.killer) {
      await tx
        .update(matches)
        .set({ houseTotal: sql`${matches.houseTotal} + ${victim.currentPot}` })
        .where(eq(matches.id, opts.matchId))
      return {
        ok: true as const,
        killerPot: null,
        killerKills: null,
        victimPot: victim.currentPot,
      }
    }

    // ACCUMULATE (slayer): no SOL moves on a kill — kills++ only; payment
    // happens once, at settlement (§6.3 supersedes payoutOnElimination).
    if (opts.mode === 'accumulate') {
      const [after] = await tx
        .update(matchPlayers)
        .set({ kills: sql`${matchPlayers.kills} + 1` })
        .where(eq(matchPlayers.id, killer!.id))
        .returning()
      return {
        ok: true as const,
        killerPot: after.currentPot,
        killerKills: after.kills,
        victimPot: victim.currentPot,
      }
    }

    // STEAL (1v1, snake): killer credited victimPot×(1−fee); the fee
    // accumulates on the match row. SQL arithmetic for the credit (§7.2).
    const houseTakes = round9(victimPotNum * feeFraction())
    const killerGets = round9(victimPotNum - houseTakes)

    const [after] = await tx
      .update(matchPlayers)
      .set({
        currentPot: sql`${matchPlayers.currentPot} + ${sol(killerGets)}`,
        kills: sql`${matchPlayers.kills} + 1`,
      })
      .where(eq(matchPlayers.id, killer!.id))
      .returning()

    await tx
      .update(matches)
      .set({ houseTotal: sql`${matches.houseTotal} + ${sol(houseTakes)}` })
      .where(eq(matches.id, opts.matchId))

    return {
      ok: true as const,
      killerPot: after.currentPot,
      killerKills: after.kills,
      victimPot: victim.currentPot,
    }
  })
}

// ─────────────────────────────────────────────────
// Settlement plumbing shared by every mode
// ─────────────────────────────────────────────────

/**
 * §7.1's atomic claim: 'active' → 'settling', one winner ever. Returns the
 * claimed match row, or null when another caller (or a previous crashed
 * attempt) already owns settlement.
 */
async function claimSettlement(matchId: string) {
  const dbh = requireDbOrThrow()
  const [claimed] = await dbh
    .update(matches)
    .set({ status: 'settling' })
    .where(and(eq(matches.id, matchId), eq(matches.status, 'active')))
    .returning()
  return claimed ?? null
}

export type SettleOutcome =
  | { ok: true; payoutSol: number; txSig: string }
  | { ok: false; error: 'already_settling' | 'no_winner_row' | 'payout_failed' }

/**
 * Winner-takes-pot settlement (1v1 and snake share it; quiz delegates to
 * it after deriving its winner). Claim → read pot from DB → send → then
 * finalise books in one transaction. A thrown send leaves 'settling' for
 * the orphaned queue (§6.2) — never auto-retried (§7.6).
 */
async function settleWinnerTakesPot(
  matchId: string,
  winner: string,
  payoutType: 'win'
): Promise<SettleOutcome> {
  const dbh = requireDbOrThrow()

  const claimed = await claimSettlement(matchId)
  if (!claimed) return { ok: false, error: 'already_settling' }

  // Payout amount from DATABASE STATE, read AFTER the claim (§6.2) — the
  // claim froze the match, so this read cannot race a late kill.
  const [winnerRow] = await dbh
    .select()
    .from(matchPlayers)
    .where(
      and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.wallet, winner))
    )
    .limit(1)
  if (!winnerRow) {
    // A claim without a winner row is an engine bug — leave 'settling' so
    // the orphaned queue surfaces it for a human.
    alert('critical', 'settlement claimed but winner row missing', {
      matchId,
      // Winner is a wallet — internal-only channel, fine here (stderr).
      winner,
    })
    return { ok: false, error: 'no_winner_row' }
  }

  const potNum = Number(winnerRow.currentPot)
  const payoutSol = round9(potNum * (1 - feeFraction()))
  const houseCut = round9(potNum - payoutSol)

  let txSig: string
  try {
    txSig = await sendPayout(winner, payoutSol)
  } catch (err) {
    // §7.6: the SOL may or may not have left — only a human with the
    // explorer can tell. Leave 'settling'; alert; do not retry.
    alert('critical', 'orphaned settlement: payout send failed', {
      matchId,
      amount: payoutSol,
      message: err instanceof Error ? err.message : 'unknown',
    })
    return { ok: false, error: 'payout_failed' }
  }

  await dbh.transaction(async (tx) => {
    await tx
      .update(matches)
      .set({
        status: 'settled',
        winner,
        settleTxSig: txSig,
        settledAt: sql`now()`,
        houseTotal: sql`${matches.houseTotal} + ${sol(houseCut)}`,
      })
      .where(eq(matches.id, matchId))
    await tx.insert(payouts).values({
      matchId,
      wallet: winner,
      amountSol: sol(payoutSol),
      type: payoutType,
      txSig,
    })
    // Final books for the winner's seat; ranks: winner 1, others by
    // elimination order (latest death = rank 2), stamped for the record.
    await tx
      .update(matchPlayers)
      .set({ status: 'cashed_out', currentPot: sol(0), placement: 1 })
      .where(
        and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.wallet, winner))
      )
    await tx.execute(sql`
      UPDATE match_players SET placement = ranked.rank
      FROM (
        SELECT id, 1 + ROW_NUMBER() OVER (
          ORDER BY eliminated_at DESC NULLS LAST
        ) AS rank
        FROM match_players
        WHERE match_id = ${matchId} AND wallet <> ${winner}
      ) ranked
      WHERE match_players.id = ranked.id
    `)
  })

  return { ok: true, payoutSol, txSig }
}

/** §6.2 — 1v1: winner takes the pot minus fee. */
export function settle1v1(opts: { matchId: string; winner: string }) {
  return settleWinnerTakesPot(opts.matchId, opts.winner, 'win')
}

/** §6.2 — snake: identical money shape to 1v1. */
export function settleSnake(opts: { matchId: string; winner: string }) {
  return settleWinnerTakesPot(opts.matchId, opts.winner, 'win')
}

// ─────────────────────────────────────────────────
// §6.3 settleSlayer
// ─────────────────────────────────────────────────

export type SlayerOutcome =
  | { ok: true; paid: Array<{ wallet: string; amountSol: number; txSig: string }> }
  | { ok: false; error: 'already_settling' | 'insolvent' | 'payout_failed' }

/**
 * One pass pays everyone by kill count when the last player stands.
 * Sequential sends ON PURPOSE (§6.3) — each send re-checks the house
 * reserve, which Promise.all would reduce to one stale check.
 */
export async function settleSlayer(opts: {
  matchId: string
}): Promise<SlayerOutcome> {
  const dbh = requireDbOrThrow()

  const claimed = await claimSettlement(opts.matchId)
  if (!claimed) return { ok: false, error: 'already_settling' }

  const entryFee = Number(claimed.betAmount)
  const players = await dbh
    .select()
    .from(matchPlayers)
    .where(eq(matchPlayers.matchId, opts.matchId))

  // SOLVENCY INVARIANT (§6.3): Σ earned must fit inside what was actually
  // deposited minus what the house already took from environment kills.
  // A violation is an engine bug about to overpay — stop before any send.
  const totalEarned = round9(
    players.reduce((sum, p) => sum + p.kills * entryFee, 0)
  )
  const available = round9(Number(claimed.totalPot) - Number(claimed.houseTotal))
  if (totalEarned > available + 1e-9) {
    alert('critical', 'slayer solvency invariant violated — settlement halted', {
      matchId: opts.matchId,
      totalEarned,
      available,
    })
    return { ok: false, error: 'insolvent' }
  }

  // Sequential payout loop. A mid-loop failure leaves 'settling' with the
  // already-paid players recorded in `payouts` — the orphaned queue plus
  // those rows tell the human exactly where it stopped (§7.6).
  const paid: Array<{ wallet: string; amountSol: number; txSig: string }> = []
  for (const p of players) {
    const earned = round9(p.kills * entryFee)
    if (earned <= 0) continue
    const payout = round9(earned * (1 - feeFraction()))
    let txSig: string
    try {
      txSig = await sendPayout(p.wallet, payout)
    } catch (err) {
      alert('critical', 'orphaned slayer settlement: payout send failed', {
        matchId: opts.matchId,
        paidSoFar: paid.length,
        message: err instanceof Error ? err.message : 'unknown',
      })
      return { ok: false, error: 'payout_failed' }
    }
    await dbh.insert(payouts).values({
      matchId: opts.matchId,
      wallet: p.wallet,
      amountSol: sol(payout),
      type: 'slayer_kill',
      txSig,
    })
    paid.push({ wallet: p.wallet, amountSol: payout, txSig })
  }

  // Finalise: remainder (pot − what was paid) accrues to the house; ranks
  // by elimination order with the survivor(s) first.
  const totalPaid = round9(paid.reduce((s, x) => s + x.amountSol, 0))
  const remainder = round9(Number(claimed.totalPot) - Number(claimed.houseTotal) - totalPaid)
  await dbh.transaction(async (tx) => {
    await tx
      .update(matches)
      .set({
        status: 'settled',
        settledAt: sql`now()`,
        houseTotal: sql`${matches.houseTotal} + ${sol(Math.max(0, remainder))}`,
      })
      .where(eq(matches.id, opts.matchId))
    await tx.execute(sql`
      UPDATE match_players SET
        placement = ranked.rank,
        status = CASE WHEN status = 'active' THEN 'cashed_out' ELSE status END,
        current_pot = 0
      FROM (
        SELECT id, ROW_NUMBER() OVER (
          ORDER BY (eliminated_at IS NULL) DESC, eliminated_at DESC
        ) AS rank
        FROM match_players
        WHERE match_id = ${opts.matchId}
      ) ranked
      WHERE match_players.id = ranked.id
    `)
  })

  return { ok: true, paid }
}

// ─────────────────────────────────────────────────
// §6.4 settleQuizFfa
// ─────────────────────────────────────────────────

/**
 * One SERVER-recorded answer. The quiz module passes its own receipt-
 * timestamped log — client timestamps and client-claimed winners are never
 * part of this type on purpose (§5.1: MatchEnd carries no winner).
 */
export interface RecordedAnswer {
  wallet: string
  correct: boolean
  /** Server-recorded ms between question open and answer receipt. */
  answerTimeMs: number
}

/**
 * Winner = most correct; tie-break lowest cumulative answer time. Then the
 * money shape is exactly settleSnake (§6.4).
 */
export async function settleQuizFfa(opts: {
  matchId: string
  answers: RecordedAnswer[]
}): Promise<SettleOutcome> {
  const tally = new Map<string, { correct: number; timeMs: number }>()
  for (const a of opts.answers) {
    const t = tally.get(a.wallet) ?? { correct: 0, timeMs: 0 }
    if (a.correct) t.correct += 1
    t.timeMs += a.answerTimeMs
    tally.set(a.wallet, t)
  }
  const ranked = [...tally.entries()].sort(
    (a, b) => b[1].correct - a[1].correct || a[1].timeMs - b[1].timeMs
  )
  const winner = ranked[0]?.[0]
  if (!winner) return { ok: false, error: 'no_winner_row' }

  return settleWinnerTakesPot(opts.matchId, winner, 'win')
}

// ─────────────────────────────────────────────────
// §6.5 resign
// ─────────────────────────────────────────────────

export type ResignOutcome =
  | { ok: true; settled: SettleOutcome | null }
  | { ok: false; error: 'not_active' | 'unknown_mode' }

/**
 * A player quits a live wager match.
 *   1v1              → their pot moves to the opponent (SQL arithmetic),
 *                      then settle1v1 with the opponent as winner.
 *   snake/slayer/quiz → pot to houseTotal; slayer also zeroes their kills
 *                      (forfeits banked kills, per the published T&C).
 */
export async function resign(opts: {
  matchId: string
  wallet: string
  gameMode: '1v1' | 'snake' | 'slayer' | 'quiz_ffa'
}): Promise<ResignOutcome> {
  const dbh = requireDbOrThrow()

  type TxResult =
    | { error: 'not_active' }
    | { opponent: string | null }
  const result = await dbh.transaction(async (tx): Promise<TxResult> => {
    // Claim the resigner's live seat (guarded update, §7.5).
    const [resigner] = await tx
      .update(matchPlayers)
      .set({
        status: 'eliminated',
        eliminatedAt: sql`now()`,
        eliminatedBy: 'resignation',
        // Slayer: banked kills are forfeited with the seat.
        ...(opts.gameMode === 'slayer' ? { kills: 0 } : {}),
      })
      .where(
        and(
          eq(matchPlayers.matchId, opts.matchId),
          eq(matchPlayers.wallet, opts.wallet),
          eq(matchPlayers.status, 'active')
        )
      )
      .returning()
    if (!resigner) return { error: 'not_active' as const }

    if (opts.gameMode === '1v1') {
      // The pot crosses to the opponent's seat in the same transaction.
      const [opponent] = await tx
        .select()
        .from(matchPlayers)
        .where(
          and(
            eq(matchPlayers.matchId, opts.matchId),
            eq(matchPlayers.status, 'active')
          )
        )
        .limit(1)
        .for('update')
      if (!opponent) return { error: 'not_active' as const }
      await tx
        .update(matchPlayers)
        .set({
          currentPot: sql`${matchPlayers.currentPot} + ${resigner.currentPot}`,
        })
        .where(eq(matchPlayers.id, opponent.id))
      await tx
        .update(matchPlayers)
        .set({ currentPot: sol(0) })
        .where(eq(matchPlayers.id, resigner.id))
      return { opponent: opponent.wallet }
    }

    // snake / slayer / quiz_ffa: the abandoned pot belongs to the house.
    await tx
      .update(matches)
      .set({ houseTotal: sql`${matches.houseTotal} + ${resigner.currentPot}` })
      .where(eq(matches.id, opts.matchId))
    await tx
      .update(matchPlayers)
      .set({ currentPot: sol(0) })
      .where(eq(matchPlayers.id, resigner.id))
    return { opponent: null }
  })

  if ('error' in result) return { ok: false, error: result.error }
  if (opts.gameMode === '1v1' && result.opponent) {
    const settled = await settle1v1({
      matchId: opts.matchId,
      winner: result.opponent,
    })
    return { ok: true, settled }
  }
  return { ok: true, settled: null }
}
