/**
 * SESSION XP — progression for the games the server does not simulate
 * ═══════════════════════════════════════════════════════════════════
 * Neon Golf Clash, Neon Clumsy and Neon Pug Shooter run entirely inside an
 * <iframe> against local bots. Nothing about them reaches the socket layer, so
 * unlike every other game there is no server-side result to award XP from —
 * and without this file they would be the only three games in the arcade that
 * pay nothing.
 *
 * THE SHAPE OF THE FIX
 *   1. Each game posts ONE message to its parent when a round finishes
 *      (`<game>:result`), carrying the outcome and whatever it counts.
 *   2. The React wrapper around the iframe hands that to `reportGameSession`.
 *   3. The server clamps it, awards XP through the SAME scoring path as every
 *      other match, and meters it under a rolling daily cap because — unlike
 *      a socket result — it cannot be verified. See the POST /api/stats/session
 *      header in apps/server/src/routes/stats.ts.
 *
 * THIS IS XP ONLY. Self-reported results never touch RP or matchmaking; the
 * worst a forged message can do is inflate someone's level, and the daily cap
 * bounds even that.
 *
 * Everything here is FIRE-AND-FORGET. A player leaving a game must never be
 * blocked, delayed, or shown an error because a progression write failed.
 */

import { statsApi } from './api'
import type { SessionReport, XpAward } from './api'

/** Fired on `window` after a session is credited, so panels can refresh. */
export const XP_AWARD_EVENT = 'neon:xp-award'

/**
 * Guard against the SAME round being reported twice.
 *
 * Two things make that a real risk rather than a theoretical one: React 18
 * StrictMode mounts effects twice in development, and a game that posts its
 * result and is then closed can fire both a result handler and an exit
 * handler. Keys are cheap and the set is per-page-load, which is the exact
 * lifetime that matters.
 */
const reported = new Set<string>()

/** Coerce anything the iframe sent into a non-negative integer. */
function count(value: unknown): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Report one finished round and return the award, or null when nothing was
 * credited (signed out, offline, duplicate, or the server declined).
 *
 * `dedupeKey` should identify the ROUND — the wrappers build it from the game
 * and the time the round started.
 */
export async function reportGameSession(
  session: SessionReport,
  dedupeKey?: string
): Promise<XpAward | null> {
  const key = dedupeKey ?? `${session.gameKey}:${session.durationMs ?? 0}`
  if (reported.has(key)) return null
  reported.add(key)

  try {
    const { award } = await statsApi.reportSession({
      ...session,
      kills: count(session.kills),
      deaths: count(session.deaths),
      score: count(session.score),
      durationMs: session.durationMs != null ? count(session.durationMs) : null,
    })

    if (award) {
      // Let the progression panels know without threading a query client
      // through three iframe wrappers.
      window.dispatchEvent(new CustomEvent(XP_AWARD_EVENT, { detail: award }))
    }
    return award
  } catch (err) {
    // Signed out, offline, rate-limited, daily cap reached — all of which are
    // "no XP this time", none of which the player can do anything about.
    console.debug('[sessionXp] session not recorded:', err)
    // Let a genuinely failed attempt be retried by a later round.
    reported.delete(key)
    return null
  }
}

/**
 * Subscribe to XP awards. Returns the unsubscribe function, so a component
 * can wire it straight into a `useEffect` cleanup.
 */
export function onXpAward(handler: (award: XpAward) => void): () => void {
  const listener = (event: Event) => {
    const award = (event as CustomEvent<XpAward>).detail
    if (award) handler(award)
  }
  window.addEventListener(XP_AWARD_EVENT, listener)
  return () => window.removeEventListener(XP_AWARD_EVENT, listener)
}
