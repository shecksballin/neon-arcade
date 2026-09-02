/**
 * GAME EVENT VALIDATION (WAGERING_IMPLEMENTATION.md §5)
 * =====================================================
 * Three gates before anything reaches the wager engine:
 *   SHAPE       — the Zod schemas below (safeParse; only parsed.data used),
 *   AUTHORITY   — checkAuthority(): both parties hold ACTIVE seats in an
 *                 ACTIVE match; the ACTOR is always socket.data.wallet,
 *   PLAUSIBILITY— the pure anti-cheat checks (kill cadence, flood).
 *
 * A rejected event is logged, counted (≥5 rejections from one wallet in
 * 10 minutes alerts), answered with a socket `error`, and NEVER partially
 * applied — the caller returns before touching the engine.
 *
 * §5.3's turn-based rule, on the record for the owner: chess and connect
 * have server-side move validation today; ANY turn-based game without a
 * validator must be REJECTED from real-money play, not trusted. Wire-up
 * of each game goes through this file's gates or it doesn't ship.
 */

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { matches, matchPlayers } from '../db/schema'
import { alert } from '../services/alertService'

// ─────────────────────────────────────────────────
// §5.1 Shape
// ─────────────────────────────────────────────────

/** killer = socket.data.wallet — NEVER in the payload. */
export const killEventSchema = z.object({
  matchId: z.string().uuid(),
  victim: z.string().min(32).max(44),
})

export const quizAnswerSchema = z.object({
  matchId: z.string().uuid(),
  questionIndex: z.number().int().min(0),
  answerIndex: z.number().int().min(0).max(3),
})

/** Deliberately NO winner field (§5.1) — the server derives it. */
export const matchEndSchema = z.object({
  matchId: z.string().uuid(),
})

export const resignSchema = z.object({
  matchId: z.string().uuid(),
})

// ─────────────────────────────────────────────────
// §5.2 Authority
// ─────────────────────────────────────────────────

export type AuthorityFailure =
  | 'match_not_active'
  | 'actor_not_active'
  | 'target_not_active'
  | 'self_kill'
  | 'no_db'

/**
 * Both parties must hold status='active' seats in a status='active' match;
 * self-kills rejected. `actor` is the verified socket wallet.
 */
export async function checkAuthority(opts: {
  matchId: string
  actor: string
  target?: string
}): Promise<AuthorityFailure | null> {
  if (!db) return 'no_db'
  if (opts.target && opts.actor === opts.target) return 'self_kill'

  const [match] = await db
    .select({ status: matches.status })
    .from(matches)
    .where(eq(matches.id, opts.matchId))
    .limit(1)
  if (!match || match.status !== 'active') return 'match_not_active'

  const activeSeat = async (wallet: string) => {
    const [row] = await db!
      .select({ id: matchPlayers.id })
      .from(matchPlayers)
      .where(
        and(
          eq(matchPlayers.matchId, opts.matchId),
          eq(matchPlayers.wallet, wallet),
          eq(matchPlayers.status, 'active')
        )
      )
      .limit(1)
    return Boolean(row)
  }

  if (!(await activeSeat(opts.actor))) return 'actor_not_active'
  if (opts.target && !(await activeSeat(opts.target))) return 'target_not_active'
  return null
}

// ─────────────────────────────────────────────────
// §5.3 Plausibility — pure, in-memory, per-process
// ─────────────────────────────────────────────────

/** Default minimum ms between one killer's kills; per-game configurable. */
export const MIN_KILL_INTERVAL_MS = 1500

// killer+match → last accepted kill timestamp.
const lastKillAt = new Map<string, number>()

/**
 * Kill cadence check (§5.3). Call ONLY after shape+authority pass; a
 * `true` return means the kill is plausible AND records this kill's
 * timestamp as the new baseline.
 */
export function plausibleKillCadence(
  killer: string,
  matchId: string,
  minIntervalMs: number = MIN_KILL_INTERVAL_MS
): boolean {
  const key = `${killer}:${matchId}`
  const now = Date.now()
  const last = lastKillAt.get(key)
  if (last !== undefined && now - last < minIntervalMs) return false
  lastKillAt.set(key, now)
  return true
}

/** Free a match's cadence entries at teardown (no central disconnect loop
 *  — each game module calls this from its own cleanup). */
export function clearKillCadence(matchId: string): void {
  for (const key of lastKillAt.keys()) {
    if (key.endsWith(`:${matchId}`)) lastKillAt.delete(key)
  }
}

// Event flood (§5.3): 60 events/min general, 20/min for kills, per socket.
const floodWindows = new Map<string, number[]>()

export function floodLimited(
  socketId: string,
  kind: 'general' | 'kill'
): boolean {
  const max = kind === 'kill' ? 20 : 60
  const key = `${socketId}:${kind}`
  const now = Date.now()
  const recent = (floodWindows.get(key) ?? []).filter((t) => t > now - 60_000)
  if (recent.length >= max) {
    floodWindows.set(key, recent)
    return true
  }
  recent.push(now)
  floodWindows.set(key, recent)
  return false
}

/** Per-socket cleanup — call from the module's own disconnect handler. */
export function clearFloodWindows(socketId: string): void {
  floodWindows.delete(`${socketId}:general`)
  floodWindows.delete(`${socketId}:kill`)
}

// ─────────────────────────────────────────────────
// Rejection logging + the ≥5-in-10-minutes alert (§9)
// ─────────────────────────────────────────────────

const rejections = new Map<string, number[]>()

/**
 * Record one plausibility rejection. Logs it; alerts when one wallet
 * accumulates 5 within 10 minutes (§9's mandatory list).
 */
export function logRejection(
  wallet: string,
  matchId: string,
  reason: string
): void {
  console.warn(
    `[gameEvents] rejected: wallet=${wallet} match=${matchId} reason=${reason}`
  )
  const now = Date.now()
  const recent = (rejections.get(wallet) ?? []).filter(
    (t) => t > now - 10 * 60_000
  )
  recent.push(now)
  rejections.set(wallet, recent)
  if (recent.length === 5) {
    alert('warn', 'repeated plausibility rejections from one wallet', {
      wallet,
      matchId,
      count: recent.length,
      lastReason: reason,
    })
  }
}
