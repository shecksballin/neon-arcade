/**
 * STATS SERVICE
 * =============
 * The ONLY place `match_results` is written or aggregated. One row per
 * PLAYER per finished match (a 1v1 writes two rows, an FFA writes N).
 *
 * THE OWNER'S RULES (design contract, "STATS RULES") — encoded here so no
 * call site has to remember them:
 *
 *   K/D          recorded + shown for Pug Shooter, Asteroids and Cells in
 *                ALL modes, INCLUDING free play (where kills/deaths are the
 *                only meaningful stat).
 *   WIN RATE     recorded + shown for every game and mode EXCEPT free play.
 *                Free play has no win condition, so it NEVER writes a
 *                win/loss — those rows carry result = 'none' and are
 *                excluded from every win-rate aggregate in this file.
 *   VIEWS        per game AND aggregated across all games.
 *   XP           awarded for EVERY row written here — every game, every mode,
 *                free play included, win or lose. Scoring lives in
 *                @neon/types/xp.ts and crediting in services/xpService.ts;
 *                this file just calls it once per row it inserts, which is
 *                what makes the rule structural rather than per-call-site.
 *                (XP is not a rating: it never falls and never resets.)
 *
 * SECURITY (contract, non-negotiable)
 * -----------------------------------
 * A wallet must NEVER reach another user. Read helpers that return other
 * people's data (the leaderboard) select `users.username` and NOTHING that
 * maps back to a wallet. `opponentUsername` is validated against the
 * username charset on the way IN, so a 44-char base58 wallet can't be
 * smuggled into a row that other code later renders.
 *
 * NULL-DB / ERROR POLICY (same as eloService)
 * -------------------------------------------
 * Every export is null-safe when `db` is null and NEVER throws into a
 * caller: writes are fire-and-forget from game loops and disconnect
 * handlers, reads return empty results so a route can 200 with zeros
 * instead of 500-ing. Failures are console.error'd and swallowed.
 */

import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { getRankInfo } from '@neon/types'
import type { RankTier } from '@neon/types'
import { db } from '../db'
import { eloHistory, matchResults, users } from '../db/schema'
import { awardMatchXp, type XpAward, type XpSource } from './xpService'

// ─────────────────────────────────────────────────
// CONSTANTS + SHARED VOCABULARY
// ─────────────────────────────────────────────────

/** Every gameKey the platform records stats for (contract list). */
export const GAME_KEYS = [
  'chess',
  'volley',
  'connect',
  'trivia',
  'cells',
  'asteroids',
  'golf',
  'clumsy',
  'pugshooter',
] as const

export type GameKey = (typeof GAME_KEYS)[number]

/** The games whose K/D is meaningful (contract: "K/D is recorded and shown
 *  for Neon Pug Shooter, Neon Asteroids, Neon Cells — ALL game modes"). */
export const KD_GAMES: readonly string[] = ['pugshooter', 'asteroids', 'cells']

/** `mode` value that marks a free-play row. THE marker for "no win
 *  condition": excluded from win rate everywhere, kept for K/D. */
export const FREEPLAY_MODE = 'freeplay'

/** Outcomes that count as a played, winnable match. */
const OUTCOMES = ['win', 'loss', 'draw'] as const

/** `result` value for rows with no win condition (free play). */
export const NO_RESULT = 'none'

export type MatchOutcome = (typeof OUTCOMES)[number] | typeof NO_RESULT

/**
 * Minimum matches before a wallet may appear on a leaderboard. Without a
 * floor a single 1-match 100% win rate would sit above every real player.
 * The UI must say so ("min 5 matches").
 */
export const LEADERBOARD_MIN_MATCHES = 5

/** Hard cap on leaderboard rows (contract asks for a top 100 board). */
const LEADERBOARD_MAX_LIMIT = 100

/** Hard cap on history page size. */
const HISTORY_MAX_LIMIT = 100

/** Usernames are the ONLY public identifier — same regex as the routes. */
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/

/** Postgres would reject a non-UUID for match_results.match_id, and room
 *  ids ("chess-abc123") are not UUIDs — validate instead of throwing. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─────────────────────────────────────────────────
// PUBLIC SHAPES (the routes agent consumes these)
// ─────────────────────────────────────────────────

/** What a caller hands us when a match finishes. */
export interface RecordResultInput {
  /** `matches.id` when one exists; anything non-UUID is stored as null. */
  matchId?: string | null
  /** The player this row is about (internal key, never echoed to others). */
  wallet: string
  /** 'chess' | 'volley' | … (see GAME_KEYS) */
  gameKey: string
  /** '1v1' | 'ffa' | 'slayer' | 'lms' | 'freeplay' | 'quiz_ffa' | … */
  mode: string
  /** Free play ignores this and is forced to 'none' — no win condition. */
  result: MatchOutcome
  kills?: number
  deaths?: number
  score?: number
  /** 1-based finishing position (FFA modes). */
  placement?: number | null
  /** PUBLIC username of the opponent — never a wallet. */
  opponentUsername?: string | null
  durationMs?: number | null
  /**
   * Where this result came from, for the XP ledger (see xpService):
   * 'match' (default) is a server-authoritative game; 'self_reported' is a
   * single-player iframe game whose result the CLIENT sent us, and is subject
   * to a daily XP cap. It has no effect on the stats row itself.
   */
  xpSource?: XpSource
}

/**
 * Aggregated stats for one game (or `gameKey: 'all'` for the combined row).
 *
 * `winRate` is a PERCENT 0–100 (one decimal) and is `null` when the player
 * has no ranked matches — render "—", not "0%". It is computed over
 * `rankedMatches` (free play excluded) as wins / rankedMatches, so draws
 * count as played and drag the rate down.
 *
 * `kd` is kills / max(deaths, 1) to two decimals — a flawless player shows
 * their kill count rather than Infinity.
 */
export interface GameStats {
  gameKey: string
  /** Every recorded row, free play included. */
  matches: number
  /** Rows that count toward win rate (free play excluded). */
  rankedMatches: number
  /** Free-play rows (K/D only). */
  freeplayMatches: number
  wins: number
  losses: number
  draws: number
  /** Percent 0–100, or null when rankedMatches === 0. */
  winRate: number | null
  kills: number
  deaths: number
  kd: number
  /** True when this game tracks a meaningful K/D (see KD_GAMES). */
  tracksKd: boolean
}

export interface PlayerStats {
  /** One entry per game the player has rows for (filtered when a gameKey
   *  was requested), newest-activity ordering is NOT guaranteed — sorted
   *  by matches desc for a stable panel. */
  perGame: GameStats[]
  /** Totals across everything in `perGame` (gameKey: 'all'). */
  combined: GameStats
}

export interface LeaderboardRow {
  /** 1-based position in the returned page. */
  rank: number
  /** The ONLY identifier ever returned — no wallets. */
  username: string
  /** K/D (2dp) or win-rate percent (1dp), matching the requested metric. */
  value: number
  /** Sample size behind `value` (K/D: all rows; win rate: ranked rows). */
  matches: number
  /** Rank tier from the RP ladder that matches the metric. */
  tier: RankTier
  /**
   * The raw RP behind `tier` (1v1 ladder for win rate, FFA ladder for K/D).
   * Sent so the client can render the DIVISION as well — "Silver III"
   * cannot be derived from a tier alone. Visible layer only: the hidden
   * TrueSkill mu/sigma never leaves the server.
   */
  rp: number
}

export interface LeaderboardQuery {
  metric: 'kd' | 'winrate'
  /** A single gameKey, or 'all' to aggregate. */
  gameKey?: string
  limit?: number
  /** Override the sample-size floor (tests/debug); defaults to 5. */
  minMatches?: number
}

export interface HistoryRow {
  gameKey: string
  mode: string
  /** 'none' for free play — the UI should render a dash, not a loss. */
  result: MatchOutcome
  kills: number
  deaths: number
  score: number
  placement: number | null
  /** Public username, or null (free play / bots / unregistered). */
  opponentUsername: string | null
  durationMs: number | null
  createdAt: Date

  // ── RANKED 2.0 ────────────────────────────────────────────────────
  // Filled from elo_history when this match actually moved a ladder.
  // All null for unranked rows (free play, practice, pre-2.0 history).
  /** Which rating pool moved: '1v1' | 'ffa'. */
  ladder: '1v1' | 'ffa' | null
  /** Signed RP won/lost on this match. */
  rpChange: number | null
  /** RP after the match settled — what the row's badge is drawn from. */
  rpAfter: number | null
  /** True when the demotion shield clamped this loss at the tier floor. */
  shielded: boolean | null
}

export interface HistoryPage {
  matches: HistoryRow[]
  /** Opaque cursor for the next page, or null when the list is exhausted. */
  nextCursor: string | null
}

// ─────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────

/** Coerce anything into a non-negative integer (bad input → 0). */
function nonNegInt(value: unknown): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Optional positive integer, or null. */
function optionalPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * SECURITY GATE for the one user-visible string on a stats row.
 * Only a valid USERNAME may be stored; a wallet (44-char base58) fails the
 * length/charset test, so no wallet can ever reach `opponentUsername` and
 * from there another player's screen.
 */
function safeUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return USERNAME_RE.test(trimmed) ? trimmed : null
}

/** Round to `places` decimals without float dust in the output. */
function round(value: number, places: number): number {
  const f = 10 ** places
  return Math.round(value * f) / f
}

/** kills / deaths, with deaths=0 treated as 1 so K/D never goes Infinity. */
function computeKd(kills: number, deaths: number): number {
  return round(kills / Math.max(deaths, 1), 2)
}

/** An empty stats bucket — the shape every read helper falls back to. */
function emptyStats(gameKey: string): GameStats {
  return {
    gameKey,
    matches: 0,
    rankedMatches: 0,
    freeplayMatches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winRate: null,
    kills: 0,
    deaths: 0,
    kd: 0,
    tracksKd: KD_GAMES.includes(gameKey),
  }
}

/**
 * SQL predicate for "this row counts toward win rate".
 * Free play is excluded by BOTH its mode and its 'none' result, so a
 * mislabelled row can't sneak into the win-rate math from either side.
 */
const RANKED_SQL = sql`${matchResults.mode} <> ${FREEPLAY_MODE} and ${matchResults.result} in ('win','loss','draw')`

/** Count rows matching a filter, as a number (int8 comes back as a string
 *  from the pg driver — mapWith(Number) normalises it). */
function countFiltered(filter: SQL) {
  return sql<number>`count(*) filter (where ${filter})`.mapWith(Number)
}

/** Sum an integer column, 0 when there are no rows. */
function sumInt(column: AnyPgColumn) {
  return sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number)
}

// ─────────────────────────────────────────────────
// WRITE PATH
// ─────────────────────────────────────────────────

/**
 * Normalise + validate one input into an insertable row, or null when the
 * input is unusable. Pure — no I/O, so it is safe to call in a loop.
 *
 * FREE PLAY RULE lives here: `mode === 'freeplay'` forces
 * result = 'none' no matter what the caller passed, which is what makes
 * "free play NEVER writes a win/loss" true by construction rather than by
 * every call site remembering it.
 */
function normalizeInput(
  input: RecordResultInput
): typeof matchResults.$inferInsert | null {
  const wallet = typeof input.wallet === 'string' ? input.wallet.trim() : ''
  const gameKey =
    typeof input.gameKey === 'string' ? input.gameKey.trim().toLowerCase() : ''
  const mode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : ''
  if (!wallet || !gameKey || !mode) {
    console.error('[statsService] recordResult: missing wallet/gameKey/mode')
    return null
  }

  // Unknown keys are still recorded (a dropped stat is worse than an odd
  // label) but flagged loudly so a typo'd call site gets noticed.
  if (!(GAME_KEYS as readonly string[]).includes(gameKey)) {
    console.warn('[statsService] unknown gameKey recorded:', gameKey)
  }

  const isFreeplay = mode === FREEPLAY_MODE
  const requested = input.result
  const result: MatchOutcome = isFreeplay
    ? NO_RESULT // free play has no win condition — never a win/loss/draw
    : (OUTCOMES as readonly string[]).includes(requested as string)
      ? (requested as MatchOutcome)
      : NO_RESULT

  return {
    matchId:
      typeof input.matchId === 'string' && UUID_RE.test(input.matchId)
        ? input.matchId
        : null,
    wallet,
    gameKey,
    mode,
    result,
    kills: nonNegInt(input.kills),
    deaths: nonNegInt(input.deaths),
    score: nonNegInt(input.score),
    placement: optionalPositiveInt(input.placement),
    opponentUsername: safeUsername(input.opponentUsername),
    durationMs: optionalPositiveInt(input.durationMs),
  }
}

/**
 * Record ONE finished match for ONE player.
 *
 * Call it from every place `settle1v1` / `settleFfa` already runs
 * (chess.ts, connect.ts, trivia.ts, volley.ts) and from the Cells/Asteroids
 * match end in socket/freeplay/ — lobby modes pass a real result plus
 * kills/deaths, free play passes mode 'freeplay' and only kills/deaths.
 *
 * Fire-and-forget safe: returns false instead of throwing, so
 * `void recordResult(...)` inside a tick loop can never break a game.
 *
 * XP is credited as a side effect (see recordResultWithXp) — game loops do
 * not wait for it. A caller that needs the award itself (to show the player
 * "+150 XP") should call recordResultWithXp instead.
 */
export async function recordResult(input: RecordResultInput): Promise<boolean> {
  const { recorded } = await recordResultWithXp(input, { awaitXp: false })
  return recorded
}

/**
 * The same write, but the XP award is AWAITED and returned.
 *
 * Used by request/response paths (the self-reported session endpoint) that
 * have to tell the player what the match paid and whether it levelled them
 * up. Game loops keep using `recordResult`, which does not block a tick on
 * the progression write.
 */
export async function recordResultWithXp(
  input: RecordResultInput,
  options: { awaitXp?: boolean } = {}
): Promise<{ recorded: boolean; award: XpAward | null }> {
  if (!db) return { recorded: false, award: null } // no db → games still play
  try {
    const row = normalizeInput(input)
    if (!row) return { recorded: false, award: null }
    await db.insert(matchResults).values(row)

    if (options.awaitXp === false) {
      void awardXpFor(row, input.xpSource)
      return { recorded: true, award: null }
    }
    return { recorded: true, award: await awardXpFor(row, input.xpSource) }
  } catch (err) {
    console.error('[statsService] recordResult failed:', err)
    return { recorded: false, award: null }
  }
}

/**
 * XP for one recorded row — the bridge between the stats table and the
 * progression ladder (services/xpService.ts).
 *
 * It hangs off the NORMALISED row on purpose: the free-play rule, the result
 * sanitising and the kill/score clamping have all already been applied, so
 * XP is scored against exactly what the database recorded and can never
 * disagree with the match history. Awarding here (rather than at each game's
 * call site) is what makes "every game awards XP" structural — a new game
 * that records a result gets progression for free.
 *
 * Fire-and-forget: awardMatchXp never throws, and an XP failure must not turn
 * a successful stats write into a failed one.
 */
async function awardXpFor(
  row: typeof matchResults.$inferInsert,
  source: XpSource | undefined
): Promise<XpAward | null> {
  return awardMatchXp({
    wallet: row.wallet,
    matchId: row.matchId ?? null,
    gameKey: row.gameKey,
    mode: row.mode,
    result: row.result as MatchOutcome,
    kills: row.kills ?? 0,
    deaths: row.deaths ?? 0,
    score: row.score ?? 0,
    placement: row.placement ?? null,
    durationMs: row.durationMs ?? null,
    source,
  })
}

/**
 * Batch form for FFA / multi-player endings: one INSERT for the whole
 * table of standings. Invalid entries are dropped individually; the rest
 * still land. Returns how many rows were written.
 */
export async function recordResults(
  inputs: RecordResultInput[]
): Promise<number> {
  if (!db) return 0
  try {
    // Keep each row paired with the source of the input it came from — the
    // batch can mix sources, and XP metering depends on knowing which.
    type Pair = { row: typeof matchResults.$inferInsert; source?: XpSource }
    const pairs = inputs.flatMap<Pair>((input) => {
      const row = normalizeInput(input)
      return row ? [{ row, source: input.xpSource }] : []
    })
    if (pairs.length === 0) return 0
    await db.insert(matchResults).values(pairs.map((p) => p.row))
    // One award per player, same rules as the single-row path.
    for (const { row, source } of pairs) void awardXpFor(row, source)
    return pairs.length
  } catch (err) {
    console.error('[statsService] recordResults failed:', err)
    return 0
  }
}

// ─────────────────────────────────────────────────
// READ PATH — player stats
// ─────────────────────────────────────────────────

/**
 * Per-game and combined stats for ONE player.
 *
 * `gameKey` is a single game or 'all':
 *   - 'all'    → perGame has one entry per game the player has played and
 *                `combined` totals every one of them.
 *   - 'chess'  → perGame has just chess and `combined` is that same game's
 *                totals (so the panel's per-game/combined toggle works
 *                without a second request).
 *
 * Never throws: returns empty stats when there is no db or the query fails.
 */
export async function getPlayerStats(
  wallet: string,
  gameKey: string | 'all' = 'all'
): Promise<PlayerStats> {
  const empty: PlayerStats = { perGame: [], combined: emptyStats('all') }
  if (!db || !wallet) return empty

  const key = typeof gameKey === 'string' ? gameKey.trim().toLowerCase() : 'all'

  try {
    const filters = [eq(matchResults.wallet, wallet)]
    if (key && key !== 'all') filters.push(eq(matchResults.gameKey, key))

    // One grouped scan; every derived number is computed in SQL so the
    // aggregate never depends on paging rows into JS.
    const rows = await db
      .select({
        gameKey: matchResults.gameKey,
        matches: sql<number>`count(*)`.mapWith(Number),
        rankedMatches: countFiltered(RANKED_SQL),
        freeplayMatches: countFiltered(
          sql`${matchResults.mode} = ${FREEPLAY_MODE}`
        ),
        wins: countFiltered(sql`${matchResults.result} = 'win' and ${RANKED_SQL}`),
        losses: countFiltered(
          sql`${matchResults.result} = 'loss' and ${RANKED_SQL}`
        ),
        draws: countFiltered(
          sql`${matchResults.result} = 'draw' and ${RANKED_SQL}`
        ),
        kills: sumInt(matchResults.kills),
        deaths: sumInt(matchResults.deaths),
      })
      .from(matchResults)
      .where(and(...filters))
      .groupBy(matchResults.gameKey)

    const perGame: GameStats[] = rows.map((r) => ({
      gameKey: r.gameKey,
      matches: r.matches,
      rankedMatches: r.rankedMatches,
      freeplayMatches: r.freeplayMatches,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
      // Win rate EXCLUDES free play (rankedMatches already does).
      winRate:
        r.rankedMatches > 0 ? round((r.wins / r.rankedMatches) * 100, 1) : null,
      kills: r.kills,
      deaths: r.deaths,
      kd: computeKd(r.kills, r.deaths),
      tracksKd: KD_GAMES.includes(r.gameKey),
    }))

    // Stable order for the panel: busiest game first, then alphabetical.
    perGame.sort(
      (a, b) => b.matches - a.matches || a.gameKey.localeCompare(b.gameKey)
    )

    // Combined = the sum of whatever is in perGame (so a filtered request
    // yields that game's totals, an 'all' request yields everything).
    const combined = perGame.reduce<GameStats>((acc, g) => {
      acc.matches += g.matches
      acc.rankedMatches += g.rankedMatches
      acc.freeplayMatches += g.freeplayMatches
      acc.wins += g.wins
      acc.losses += g.losses
      acc.draws += g.draws
      acc.kills += g.kills
      acc.deaths += g.deaths
      return acc
    }, emptyStats(key === 'all' ? 'all' : key))

    combined.winRate =
      combined.rankedMatches > 0
        ? round((combined.wins / combined.rankedMatches) * 100, 1)
        : null
    combined.kd = computeKd(combined.kills, combined.deaths)
    combined.tracksKd =
      key === 'all'
        ? perGame.some((g) => g.tracksKd)
        : KD_GAMES.includes(key)

    return { perGame, combined }
  } catch (err) {
    console.error('[statsService] getPlayerStats failed:', err)
    return empty
  }
}

// ─────────────────────────────────────────────────
// READ PATH — leaderboard
// ─────────────────────────────────────────────────

/**
 * Top players by K/D or win rate.
 *
 * SECURITY: the projection is `users.username` only. No wallet, no id, no
 * email — the join key never leaves this function.
 *
 * SAMPLE FLOOR: a wallet needs >= LEADERBOARD_MIN_MATCHES qualifying rows,
 * so a lucky 1-match 100% can't top the board (say so in the UI).
 *
 * Scope per metric:
 *   winrate — free-play rows are excluded outright, so `matches` is the
 *             ranked sample and the floor applies to it.
 *   kd      — ALL modes count (free play is where K/D matters most). With
 *             gameKey 'all' the board aggregates only the K/D games
 *             (pugshooter/asteroids/cells) so chess matches can't pad
 *             someone over the sample floor.
 *
 * Never throws: returns [] on any failure.
 */
export async function getLeaderboard(
  query: LeaderboardQuery
): Promise<LeaderboardRow[]> {
  if (!db) return []

  const metric = query.metric === 'kd' ? 'kd' : 'winrate'
  const key =
    typeof query.gameKey === 'string' ? query.gameKey.trim().toLowerCase() : 'all'
  const limit = Math.min(
    Math.max(Math.floor(query.limit ?? LEADERBOARD_MAX_LIMIT) || 0, 1),
    LEADERBOARD_MAX_LIMIT
  )
  const minMatches = Math.max(
    Math.floor(query.minMatches ?? LEADERBOARD_MIN_MATCHES) || 0,
    1
  )

  try {
    // WHERE: registered users only (a null username has no public identity
    // and must never be represented on a public board).
    const filters: SQL[] = [isNotNull(users.username)]

    if (key && key !== 'all') {
      filters.push(eq(matchResults.gameKey, key))
    } else if (metric === 'kd') {
      // 'all' + K/D → only the games that actually track kills/deaths.
      filters.push(inArray(matchResults.gameKey, [...KD_GAMES]))
    }

    if (metric === 'winrate') {
      // Free play never counts toward win rate — filtered here, so both
      // `matches` and the sample floor see the ranked set only.
      filters.push(RANKED_SQL)
    }

    // The ranking expression, written ONCE: `rawValue` sorts, `valueExpr`
    // is the rounded number we return, so the order can never disagree
    // with what the UI shows (rounding is monotonic).
    const rawValue =
      metric === 'kd'
        ? sql`(sum(${matchResults.kills})::numeric / greatest(sum(${matchResults.deaths}), 1))`
        : sql`(count(*) filter (where ${matchResults.result} = 'win')::numeric * 100 / count(*))`
    // The scale is a literal (sql.raw), never a bind param: `round(numeric,
    // int)` resolves cleanly that way, and the value is ours — not input.
    const places = sql.raw(metric === 'kd' ? '2' : '1')
    const valueExpr = sql<number>`round(${rawValue}, ${places})`.mapWith(Number)

    const rows = await db
      .select({
        username: users.username,
        // RANKED 2.0: rank off the RP columns, not the legacy elo mirror.
        rp: users.rp1v1,
        rpFfa: users.rpFfa,
        matches: sql<number>`count(*)`.mapWith(Number),
        value: valueExpr,
      })
      .from(matchResults)
      .innerJoin(users, eq(users.wallet, matchResults.wallet))
      .where(and(...filters))
      // Group by the users PK: one row per player, wallet never projected.
      .groupBy(users.id, users.username, users.rp1v1, users.rpFfa)
      .having(sql`count(*) >= ${minMatches}`)
      // Deterministic order: value, then the bigger sample, then name.
      .orderBy(sql`${rawValue} desc`, sql`count(*) desc`, asc(users.username))
      .limit(limit)

    return rows.map((r, i) => {
      // K/D lives in the FFA rating pool (rp_ffa); win rate is the 1v1
      // ladder (rp_1v1). Show the badge that belongs to the metric on
      // screen, and send the raw RP so the client can draw the DIVISION
      // too (a division cannot be derived from a tier alone).
      const rp = metric === 'kd' ? r.rpFfa : r.rp
      return {
        rank: i + 1,
        username: r.username ?? '',
        value: Number(r.value ?? 0),
        matches: r.matches,
        tier: getRankInfo(rp).tier,
        rp,
      }
    })
  } catch (err) {
    console.error('[statsService] getLeaderboard failed:', err)
    return []
  }
}

// ─────────────────────────────────────────────────
// READ PATH — match history
// ─────────────────────────────────────────────────

/**
 * Encode/decode the keyset cursor. `createdAt|id` (not an offset) so new
 * matches landing mid-scroll can't duplicate or skip a row, and ties on
 * createdAt (two games ending in the same millisecond) still page cleanly.
 */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`
}

function decodeCursor(cursor?: string | null): { at: Date; id: string } | null {
  if (!cursor || typeof cursor !== 'string') return null
  const [iso, id] = cursor.split('|')
  if (!iso || !id || !UUID_RE.test(id)) return null
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : { at, id }
}

/**
 * Recent matches for ONE player, newest first, keyset-paginated.
 * Free-play rows appear with result 'none' — the UI renders a dash there,
 * never a loss.
 *
 * Never throws: returns an empty page on any failure.
 */
export async function getHistory(
  wallet: string,
  limit = 50,
  cursor?: string | null
): Promise<HistoryPage> {
  const empty: HistoryPage = { matches: [], nextCursor: null }
  if (!db || !wallet) return empty

  const take = Math.min(Math.max(Math.floor(limit) || 0, 1), HISTORY_MAX_LIMIT)

  try {
    const after = decodeCursor(cursor)
    const filters = [eq(matchResults.wallet, wallet)]
    if (after) {
      // Strictly "older than the last row I showed", tie-broken by id.
      filters.push(
        or(
          lt(matchResults.createdAt, after.at),
          and(eq(matchResults.createdAt, after.at), lt(matchResults.id, after.id))
        )!
      )
    }

    // Fetch one extra row to learn whether another page exists without a
    // second COUNT query.
    const rows = await db
      .select({
        id: matchResults.id,
        // Selected but NEVER returned: it is only the key that lets us look
        // up the RANKED side of this match (see the elo_history read below).
        matchId: matchResults.matchId,
        gameKey: matchResults.gameKey,
        mode: matchResults.mode,
        result: matchResults.result,
        kills: matchResults.kills,
        deaths: matchResults.deaths,
        score: matchResults.score,
        placement: matchResults.placement,
        opponentUsername: matchResults.opponentUsername,
        durationMs: matchResults.durationMs,
        createdAt: matchResults.createdAt,
      })
      .from(matchResults)
      .where(and(...filters))
      .orderBy(desc(matchResults.createdAt), desc(matchResults.id))
      .limit(take + 1)

    const page = rows.slice(0, take)
    const last = page[page.length - 1]

    /**
     * RANKED 2.0 — attach the RP move to each row.
     *
     * `match_results` and `elo_history` are two independent append-only
     * tables (neither is a foreign key of the other) that the game handlers
     * write with the SAME match id. So this is a second, exact lookup rather
     * than a JOIN: joining risks multiplying rows when one match id carries
     * several rating writes (the permanent free-play world reuses its match
     * id across rounds), whereas a keyed map keeps it strictly one-to-one.
     *
     * Rows that don't line up — unranked games, rows written before Ranked
     * 2.0, anything settled without a uuid — simply come back without RP
     * fields, which the client already renders as "no RP change".
     */
    const rankedIds = [...new Set(page.map((r) => r.matchId).filter((v): v is string => !!v))]
    const rpByMatch = new Map<
      string,
      { ladder: string | null; rpChange: number | null; rpAfter: number | null; shielded: boolean | null }
    >()
    if (rankedIds.length > 0) {
      const rpRows = await db
        .select({
          matchId: eloHistory.matchId,
          ladder: eloHistory.ladder,
          rpChange: eloHistory.rpChange,
          rpAfter: eloHistory.rpAfter,
          shielded: eloHistory.shielded,
          createdAt: eloHistory.createdAt,
        })
        .from(eloHistory)
        .where(and(eq(eloHistory.wallet, wallet), inArray(eloHistory.matchId, rankedIds)))
        .orderBy(desc(eloHistory.createdAt))
      // Newest first, and the first write for a match id wins — so a reused
      // free-play match id reports its most recent rating move.
      for (const r of rpRows) {
        if (!r.matchId || rpByMatch.has(r.matchId)) continue
        // Pre-2.0 rows have a null ladder and no RP columns; skip them so an
        // old row can never masquerade as a ranked one.
        if (r.ladder === null && r.rpChange === null) continue
        rpByMatch.set(r.matchId, {
          ladder: r.ladder,
          rpChange: r.rpChange,
          rpAfter: r.rpAfter,
          shielded: r.shielded,
        })
      }
    }

    return {
      matches: page.map((r) => {
        const rp = r.matchId ? rpByMatch.get(r.matchId) : undefined
        return {
          gameKey: r.gameKey,
          mode: r.mode,
          result: r.result as MatchOutcome,
          kills: r.kills,
          deaths: r.deaths,
          score: r.score,
          placement: r.placement,
          // Already username-validated on insert — no wallet can be here.
          opponentUsername: r.opponentUsername,
          durationMs: r.durationMs,
          createdAt: r.createdAt,
          ladder: (rp?.ladder as '1v1' | 'ffa' | null | undefined) ?? null,
          rpChange: rp?.rpChange ?? null,
          rpAfter: rp?.rpAfter ?? null,
          shielded: rp?.shielded ?? null,
        }
      }),
      nextCursor: rows.length > take && last ? encodeCursor(last) : null,
    }
  } catch (err) {
    console.error('[statsService] getHistory failed:', err)
    return empty
  }
}
