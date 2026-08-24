/**
 * STATS ROUTES (Hono) — my stats, the leaderboards, my history, my XP
 * ===================================================================
 * Reads over `match_results` plus the progression ladder, all behind
 * requireAuth:
 *
 *   GET  /api/stats/me?gameKey=<key|all>
 *   GET  /api/stats/leaderboard?metric=kd|winrate|xp&gameKey=<key|all>&limit=100
 *   GET  /api/stats/history?limit=50&cursor=<opaque>
 *   GET  /api/stats/xp
 *   POST /api/stats/session      ← the ONE write, and the ONE place a client
 *                                  may state a result (see its own header)
 *
 * Every query is executed by `services/statsService.ts` (Drizzle only) — this
 * file is validation + shaping, nothing else. The service never throws and is
 * null-db safe, so these routes answer 200 with empty/zeroed data on a server
 * without a database instead of 500-ing a panel that is just trying to render.
 *
 * SECURITY (design contract, non-negotiable)
 * ------------------------------------------
 * - Identity is ALWAYS `c.get('wallet')` from the verified JWT. A wallet in a
 *   query string is never read, so nobody can ask for someone else's stats.
 * - The ONLY public identifier that leaves here is `username` (leaderboard
 *   rows and `opponentUsername` on history rows — both already username-
 *   validated inside statsService). No wallets, no emails, no ids.
 * - Every query parameter is zod-parsed; unknown gameKeys/metrics are
 *   rejected rather than passed through to SQL (they are bound params either
 *   way, this just keeps the surface honest).
 * - Per-wallet rate limit: these are cheap grouped scans, but a panel that
 *   polls in a tight loop (or someone trying to) should not be able to pin a
 *   database core.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { requireAuth, type AuthVariables } from '../middleware/requireAuth'
import { createRateLimiter } from '../lib/rateLimit'
import {
  FREEPLAY_MODE,
  GAME_KEYS,
  KD_GAMES,
  LEADERBOARD_MIN_MATCHES,
  getHistory,
  getLeaderboard,
  getPlayerStats,
  recordResultWithXp,
} from '../services/statsService'
import {
  SELF_REPORTED_DAILY_CAP,
  getXpLeaderboard,
  getXpSummary,
  selfReportedRemaining,
} from '../services/xpService'

const stats = new Hono<{ Variables: AuthVariables }>()

// Everything here is about the signed-in account (or a public board that is
// still only readable by a signed-in user).
stats.use('*', requireAuth)

// Read budget per wallet. Generous enough for a panel that refetches on every
// open/tab switch, small enough that a runaway loop gets throttled.
const readLimited = createRateLimiter(60 * 1000, 120)

// ─────────────────────────────────────────────────
// Shared query validation
// ─────────────────────────────────────────────────

/** A single game, or the aggregate view. Defaults to 'all'. */
const gameKeyQuery = z
  .enum([...GAME_KEYS, 'all'] as [string, ...string[]])
  .optional()
  .default('all')

const MeQuerySchema = z.object({
  gameKey: gameKeyQuery,
})

const LeaderboardQuerySchema = z.object({
  // 'xp' ranks by career XP (i.e. by level) across the WHOLE arcade, so it
  // ignores gameKey — see the handler.
  metric: z.enum(['kd', 'winrate', 'xp']).optional().default('winrate'),
  gameKey: gameKeyQuery,
  // Contract: TOP 100. The service clamps too — this just rejects garbage
  // early with a readable message instead of silently coercing it.
  limit: z.coerce.number().int().min(1).max(100).optional().default(100),
})

const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  // Opaque keyset cursor minted by statsService (`<iso>|<uuid>`). Length-
  // capped here; the service validates the shape and ignores anything odd.
  cursor: z.string().max(120).optional(),
})

/** 429 helper — one budget shared by all three reads, keyed by wallet. */
function tooManyRequests(wallet: string): boolean {
  return readLimited(`stats:${wallet}`)
}

/**
 * Query params with EMPTY values dropped. A UI that builds
 * `?gameKey=&limit=` from unset state is asking for the defaults, not for a
 * 400 — stripping empties here keeps the schemas strict without punishing
 * that (very normal) client shape.
 */
function queryParams(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value !== '') out[key] = value
  }
  return out
}

// ─────────────────────────────────────────────────
// GET /api/stats/me?gameKey=<key|all>
// ─────────────────────────────────────────────────
// The Stats panel's per-game / combined toggle: `perGame` is one row per game
// the player has played (filtered when a gameKey is given) and `combined` is
// the total across exactly those rows, so both halves of the toggle come from
// ONE request.
//
// Reading the numbers (rules encoded in statsService, repeated for the UI):
//   winRate  percent 0–100, or NULL when there are no ranked matches — render
//            "—", never "0%". Free play is excluded from it entirely.
//   kd       kills / max(deaths, 1); only meaningful when `tracksKd` is true.
stats.get('/me', async (c) => {
  const wallet = c.get('wallet')
  if (tooManyRequests(wallet)) {
    return c.json({ error: 'Too many requests — slow down' }, 429)
  }

  const parsed = MeQuerySchema.safeParse(queryParams(c.req.query()))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid query' }, 400)
  }

  const { perGame, combined } = await getPlayerStats(wallet, parsed.data.gameKey)

  return c.json({
    gameKey: parsed.data.gameKey,
    perGame,
    combined,
    // Static vocabulary so the panel can label things without hardcoding the
    // contract's game list in two places.
    kdGames: KD_GAMES,
  })
})

// ─────────────────────────────────────────────────
// GET /api/stats/leaderboard?metric=kd|winrate&gameKey=<key|all>&limit=100
// ─────────────────────────────────────────────────
// Top 100 by K/D or win rate. Rows carry `username` and NOTHING that maps back
// to a wallet (the join key never leaves statsService).
//
// `minMatches` is returned so the UI can say "min 5 matches" — the contract
// asks for that floor to be visible, not just enforced.
stats.get('/leaderboard', async (c) => {
  const wallet = c.get('wallet')
  if (tooManyRequests(wallet)) {
    return c.json({ error: 'Too many requests — slow down' }, 429)
  }

  const parsed = LeaderboardQuerySchema.safeParse(queryParams(c.req.query()))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid query' }, 400)
  }
  const { metric, gameKey, limit } = parsed.data

  // XP is a different board: it is ranked off `users.xp` (one number for the
  // whole arcade, no per-game split and no sample floor — XP already IS a
  // measure of how much someone has played), so it answers with `level`-
  // shaped rows rather than the metric/gameKey ones below.
  if (metric === 'xp') {
    return c.json({
      metric,
      gameKey: 'all',
      excludesFreeplay: false,
      // Everyone with any XP qualifies — say so rather than sending 5.
      minMatches: 0,
      rows: await getXpLeaderboard(limit),
    })
  }

  const rows = await getLeaderboard({ metric, gameKey, limit })

  return c.json({
    metric,
    gameKey,
    // Free play never counts toward win rate (it has no win condition); K/D
    // deliberately DOES include it. Surfaced so the panel can footnote it.
    excludesFreeplay: metric === 'winrate',
    minMatches: LEADERBOARD_MIN_MATCHES,
    rows,
  })
})

// ─────────────────────────────────────────────────
// GET /api/stats/history?limit=50&cursor=
// ─────────────────────────────────────────────────
// The signed-in player's recent matches, newest first, keyset-paginated
// (`nextCursor` is null when the list is exhausted).
//
// Free-play rows arrive with result 'none' — the UI must render a dash there,
// never a loss.
stats.get('/history', async (c) => {
  const wallet = c.get('wallet')
  if (tooManyRequests(wallet)) {
    return c.json({ error: 'Too many requests — slow down' }, 429)
  }

  const parsed = HistoryQuerySchema.safeParse(queryParams(c.req.query()))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid query' }, 400)
  }

  const { matches, nextCursor } = await getHistory(
    wallet,
    parsed.data.limit,
    parsed.data.cursor ?? null
  )

  return c.json({ matches, nextCursor })
})

// ─────────────────────────────────────────────────
// GET /api/stats/xp
// ─────────────────────────────────────────────────
// The signed-in player's progression: career XP, the derived level (with the
// progress bar numbers) and the most recent awards.
//
// The LEVEL is derived, never stored — the client can recompute the identical
// value from `xp` with getLevelInfo() out of @neon/types, which is what the
// panels do when they already have the profile payload in hand.
stats.get('/xp', async (c) => {
  const wallet = c.get('wallet')
  if (tooManyRequests(wallet)) {
    return c.json({ error: 'Too many requests — slow down' }, 429)
  }

  const summary = await getXpSummary(wallet)

  return c.json({
    ...summary,
    // Only meaningful for the self-reported games; sent so the UI can explain
    // a session that paid less than the player expected.
    selfReported: {
      dailyCap: SELF_REPORTED_DAILY_CAP,
      remaining: await selfReportedRemaining(wallet),
    },
  })
})

// ─────────────────────────────────────────────────
// POST /api/stats/session   { gameKey, mode, result, ... }
// ─────────────────────────────────────────────────
/**
 * THE ONE WRITE ENDPOINT ON THIS ROUTER, and the only place in the platform a
 * CLIENT gets to state a match result. Read this before extending it.
 *
 * WHY IT EXISTS: Neon Golf Clash, Neon Clumsy and Neon Pug Shooter run
 * entirely inside an iframe against local bots — there is no server-side
 * simulation of them to write a result from. Without this endpoint those
 * three games would be the only ones in the arcade that award nothing, which
 * is exactly the hole the progression system is supposed to close.
 *
 * WHAT KEEPS IT HONEST — a caller can lie, so the damage is bounded instead:
 *   • ONLY the three unsimulated games are accepted. Everything the server
 *     actually runs (chess, volley, connect, trivia, cells, asteroids) is
 *     rejected here — those results come from the socket handlers, and
 *     accepting a client's word for them would be a rating exploit.
 *   • NO RP, EVER. This writes a stats row and XP; ranked ladders are
 *     untouchable from the client side.
 *   • Every number is clamped server-side (kills, score, duration) and the
 *     award runs through the same cap as every other match.
 *   • XP is booked as `self_reported`, which is metered by a rolling daily
 *     cap in xpService — a scripted reporter hits it in minutes.
 *   • Per-wallet rate limit on top, so the endpoint cannot be used to hammer
 *     the database either.
 */

/** The games with no server-side simulation — accepted in every mode. */
const SELF_REPORTED_GAMES = ['golf', 'clumsy', 'pugshooter'] as const

/**
 * Server-simulated games whose PRACTICE (vs-AI) rounds may also self-report.
 * Practice runs entirely client-side — the socket layer never sees it — so
 * without this the four flagship games paid XP online but nothing at all in
 * practice. The contract is deliberately narrower than SELF_REPORTED_GAMES:
 *   • mode is FORCED to 'practice' (a client claiming a '1v1' chess win here
 *     would otherwise sit beside socket-authoritative rows in history);
 *   • kills/deaths/placement are FORCED to zero/null — none of these games
 *     have them, and accepting the fields would hand a scripted reporter
 *     +150 kill XP and a fabricated K/D;
 *   • practice rows are excluded from win-rate stats and leaderboards
 *     (statsService RANKED_SQL) — XP only, exactly like the iframe games'
 *     "THIS IS XP ONLY" rule, with one more fence.
 * Their ONLINE results still arrive exclusively via the socket handlers.
 */
const PRACTICE_REPORTED_GAMES = [
  'chess',
  'connect',
  'volley',
  // Neon Kickoff took Neon Quiz's slot: its practice shootout is the same
  // shape (fully client-side round vs the AI keeper).
  'kickoff',
  // Asteroids/Cells practice is the same shape: a fully client-side round
  // vs bots the socket layer never sees. Their ONLINE results stay
  // socket-authoritative (freeplay worlds), exactly like the four above.
  'asteroids',
  'cells',
] as const

/** Modes the iframe games may report. `freeplay` keeps the platform's
 *  meaning: no win condition, so it can never carry a win/loss. */
const SELF_REPORTED_MODES = ['1v1', 'practice', 'ffa', FREEPLAY_MODE] as const

/** Nothing self-reported may claim more than this. Well above a real round,
 *  far below what a fabricated payload would try. */
const MAX_REPORTED_KILLS = 200
const MAX_REPORTED_SCORE = 100_000
const MAX_REPORTED_DURATION_MS = 4 * 60 * 60 * 1000 // 4h
const MAX_REPORTED_PLACEMENT = 64

const SessionSchema = z.object({
  gameKey: z.enum([...SELF_REPORTED_GAMES, ...PRACTICE_REPORTED_GAMES]),
  mode: z.enum(SELF_REPORTED_MODES).optional().default('practice'),
  result: z.enum(['win', 'loss', 'draw', 'none']).optional().default('none'),
  kills: z.coerce.number().int().min(0).max(MAX_REPORTED_KILLS).optional().default(0),
  deaths: z.coerce.number().int().min(0).max(MAX_REPORTED_KILLS).optional().default(0),
  score: z.coerce.number().int().min(0).max(MAX_REPORTED_SCORE).optional().default(0),
  placement: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_REPORTED_PLACEMENT)
    .optional()
    .nullable(),
  durationMs: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_REPORTED_DURATION_MS)
    .optional()
    .nullable(),
})

/**
 * Sessions are minutes long, so a handful a minute is already generous — this
 * is the throttle, the daily XP cap is the economy.
 */
const sessionLimited = createRateLimiter(60 * 1000, 10)

stats.post('/session', async (c) => {
  const wallet = c.get('wallet')
  if (sessionLimited(`session:${wallet}`)) {
    return c.json({ error: 'Too many sessions reported — slow down' }, 429)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = SessionSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid session' }, 400)
  }
  const session = parsed.data

  // Server-simulated games get the NARROW practice contract (see
  // PRACTICE_REPORTED_GAMES): whatever the client claimed, the row that
  // lands is a kill-less, placement-less practice round.
  const practiceOnly = (PRACTICE_REPORTED_GAMES as readonly string[]).includes(
    session.gameKey
  )

  const { recorded, award } = await recordResultWithXp({
    // No `matchId`: nothing here corresponds to a server-side match row.
    wallet,
    gameKey: session.gameKey,
    mode: practiceOnly ? 'practice' : session.mode,
    // statsService forces 'none' for free play anyway — this keeps the two
    // agreeing for the other modes.
    result: session.result,
    kills: practiceOnly ? 0 : session.kills,
    deaths: practiceOnly ? 0 : session.deaths,
    score: session.score,
    placement: practiceOnly ? null : (session.placement ?? null),
    durationMs: session.durationMs ?? null,
    // The bit that meters it. Never remove.
    xpSource: 'self_reported',
  })

  if (!recorded) {
    // No database, or the row was unusable. Not an error the player can act
    // on — the game already happened — so answer 200 with nothing awarded.
    return c.json({ recorded: false, award: null })
  }

  return c.json({ recorded: true, award })
})

export default stats
