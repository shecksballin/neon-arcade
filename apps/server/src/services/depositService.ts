/**
 * DEPOSIT SERVICE (WAGERING_IMPLEMENTATION.md §4.2)
 * =================================================
 * The confirm sequence, in the spec's mandatory order:
 *
 *   nonce → on-chain verify → deposits row (replay 409) → seat + pot,
 *   all DB writes in ONE transaction, then the lobby broadcast.
 *
 * Nothing here reads amounts from anywhere but the request body ONCE —
 * and only after verifyDeposit has proven the chain actually received
 * that amount from that wallet. From then on the DB rows are the truth.
 */

import { eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { deposits, matches, matchPlayers } from '../db/schema'
import { consumeNonce } from './nonceService'
import { verifyDeposit } from '../solana/payoutService'

// ─────────────────────────────────────────────────
// Socket bridge — same shape as routes/social.ts's
// setSocialRealtime: the socket layer registers an
// emitter at boot; HTTP handlers stay io-free.
// ─────────────────────────────────────────────────

type MatchEmitter = (matchId: string, event: string, payload: object) => void
let emitToMatch: MatchEmitter | null = null

/** Called once from socket/index.ts at boot. */
export function setWagerRealtime(emitter: MatchEmitter): void {
  emitToMatch = emitter
}

/** The socket.io room a match's players sit in (game modules join it). */
export function matchRoom(matchId: string): string {
  return `match:${matchId}`
}

// ─────────────────────────────────────────────────
// Confirm
// ─────────────────────────────────────────────────

export type ConfirmDepositResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string }

/**
 * Verify and credit one deposit. `wallet` is the JWT identity — the route
 * passes `c.get('wallet')`, never a body field (absolute rule §0.2).
 */
export async function confirmDeposit(opts: {
  wallet: string
  matchId: string
  txSig: string
  nonce: string
  amountSol: number
}): Promise<ConfirmDepositResult> {
  if (!db) return { ok: false, status: 503, error: 'no database' }

  // 2. One-time nonce — a replayed/expired/foreign nonce dies here, before
  //    we spend RPC calls verifying anything.
  if (!(await consumeNonce(opts.nonce, opts.wallet))) {
    return { ok: false, status: 400, error: 'invalid or expired nonce' }
  }

  // The match must exist and still be joinable before we verify the chain
  // — otherwise a deposit into a dead lobby verifies and then has nowhere
  // to sit (the SOL would be stranded in the house wallet).
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, opts.matchId))
    .limit(1)
  if (!match) return { ok: false, status: 404, error: 'match not found' }
  if (match.status !== 'open' && match.status !== 'active') {
    return { ok: false, status: 400, error: 'match is not accepting deposits' }
  }

  // 3. On-chain proof: real, recent, successful, from THIS wallet, into
  //    the house wallet, for at least the claimed amount.
  try {
    await verifyDeposit({
      txSignature: opts.txSig,
      expectedSender: opts.wallet,
      expectedAmountSOL: opts.amountSol,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'verification failed'
    return { ok: false, status: 400, error: msg }
  }

  // 4 + 5. Ledger writes, one transaction: the deposits row (whose UNIQUE
  // txSig is the replay backstop), the seat, and the pot increment either
  // all land or none do.
  const amount = opts.amountSol.toFixed(9)
  try {
    await db.transaction(async (tx) => {
      await tx.insert(deposits).values({
        matchId: opts.matchId,
        wallet: opts.wallet,
        amountSol: amount,
        txSig: opts.txSig,
      })
      await tx.insert(matchPlayers).values({
        matchId: opts.matchId,
        wallet: opts.wallet,
        status: 'deposited',
        depositSol: amount,
        currentPot: amount,
      })
      await tx
        .update(matches)
        .set({ totalPot: sql`${matches.totalPot} + ${amount}` })
        .where(eq(matches.id, opts.matchId))
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Replayed txSig (or a second live seat) — §4.2 step 4: 409, credit
      // nothing. The transaction already rolled back everything.
      return { ok: false, status: 409, error: 'deposit already credited' }
    }
    throw err
  }

  // 6. Tell the lobby. Usernames are resolved client-side from the roster;
  //    the wallet stays server-side except to the match's own room, where
  //    the roster protocol already carries public identity.
  emitToMatch?.(opts.matchId, 'lobby:playerDeposited', {
    matchId: opts.matchId,
    amountSol: opts.amountSol,
  })

  return { ok: true }
}

/** Postgres unique violation (23505) — same check wagerService uses. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  return (
    e?.code === '23505' || /duplicate key/i.test(String(e?.message ?? ''))
  )
}
