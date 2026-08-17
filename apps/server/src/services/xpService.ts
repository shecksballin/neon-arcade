/**
 * XP SERVICE — the progression ladder (every game, every mode)
 * ════════════════════════════════════════════════════════════
 * The ONLY place `users.xp` is mutated and `xp_events` is written.
 *
 * WHAT MAKES THIS DIFFERENT FROM rankService
 * ------------------------------------------
 * RP is a rating: zero-sum, seasonal, ranked matches only, and it can fall.
 * XP is a record of time invested: it only ever goes UP, it survives a season
 * rollover, and EVERY game pays it — free play, slayer and the single-player
 * iframe games included. The curve that turns the counter into a level lives
 * in @neon/types/xp.ts and is shared with the client.
 *
 * ATOMICITY — and why there is no transaction here.
 * rankService must lock rows because a rating is read-modify-write (the new
 * value depends on the old one). An XP award is a pure INCREMENT, so
 *
 *     update users set xp = xp + n returning xp
 *
 * is already race-free: two concurrent awards commute and Postgres serialises
 * the row update itself. `xp_before` is then recovered by subtraction, which
 * is exact because nothing else writes the column.
 *
 * SELF-REPORTED RESULTS (the one place trust is an issue)
 * ------------------------------------------------------
 * Golf, Clumsy and Pug Shooter run entirely in an iframe with no server-side
 * simulation, so their results reach us from the CLIENT and cannot be
 * verified. They are still worth XP — the alternative is three games that
 * award nothing — but they are:
 *   • marked `source: 'self_reported'` in the ledger,
 *   • clamped by the same per-match cap as everything else, and
 *   • held under a DAILY cap (SELF_REPORTED_DAILY_CAP) that a scripted
 *     reporter hits in a few minutes and an honest player never notices.
 * Nothing self-reported touches RP. Ratings stay server-authoritative.
 *
 * NULL-DB / ERROR POLICY (same as statsService/eloService)
 * -------------------------------------------------------
 * Every export is null-safe when `db` is null and NEVER throws into a caller:
 * awards are fire-and-forget from game loops, reads return empty/zeroed
 * results so a route can 200 instead of 500-ing a panel. Failures are
 * console.error'd and swallowed — a lost XP award is an annoyance, a crashed
 * match is not.
 */

import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import {
  computeMatchXp,
  getLevelInfo,
  levelFromXp,
  type LevelInfo,
  type MatchXpInput,
  type XpBreakdown,
} from '@neon/types'
import { db } from '../db'
import { users, xpEvents } from '../db/schema'

// ─────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────

/** Where an award came from. Only 'self_reported' is rate-limited. */
export type XpSource = 'match' | 'self_reported'

/**
 * Most XP the unverifiable single-player games may pay one wallet per day.
 * Sized at roughly eight good sessions: an honest player finishing a handful
 * of rounds never meets it, a bot posting results in a loop meets it almost
 * immediately.
 */
export const SELF_REPORTED_DAILY_CAP = 1_200

/** The window the cap is measured over. */
export const SELF_REPORTED_WINDOW_MS = 24 * 60 * 60 * 1000

/** How many ledger rows the "recent XP" read returns by default. */
const RECENT_EVENTS_DEFAULT = 10
const RECENT_EVENTS_MAX = 50

/** Hard cap on XP leaderboard rows (mirrors the stats leaderboard). */
const LEADERBOARD_MAX_LIMIT = 100

/** Same UUID guard statsService uses — room ids are not UUIDs. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─────────────────────────────────────────────────
// PUBLIC SHAPES
// ─────────────────────────────────────────────────

/** What one award did to a player's progression. */
export interface XpAward {
  amount: number
  xpBefore: number
  xpAfter: number
  levelBefore: number
  levelAfter: number
  /** True when this award crossed at least one level boundary. */
  leveledUp: boolean
  /** The full level read-out AFTER the award — what the UI draws. */
  level: LevelInfo
  /** Itemised award, when it came from a match (null for manual grants). */
  breakdown: XpBreakdown | null
  /**
   * Set when the daily self-reported cap clamped the award: how much was
   * dropped. Zero/absent on every normal award.
   */
  cappedBy?: number
}

/** One row of the progression feed. */
export interface XpEventRow {
  gameKey: string
  mode: string
  amount: number
  source: XpSource
  breakdown: XpBreakdown | null
  levelBefore: number
  levelAfter: number
  leveledUp: boolean
  createdAt: Date
}

/** The whole progression panel in one payload. */
export interface XpSummary {
  xp: number
  level: LevelInfo
  recent: XpEventRow[]
  /** XP earned in the last 24h (all sources) — a small "today" read-out. */
  earnedToday: number
}

export interface XpLeaderboardRow {
  rank: number
  /** The ONLY identifier ever returned — no wallets (same rule as stats). */
  username: string
  xp: number
  level: number
  band: string
  color: string
}

/** Everything an award call site needs to supply. */
export interface AwardXpInput {
  wallet: string
  amount: number
  gameKey: string
  mode: string
  matchId?: string | null
  source?: XpSource
  breakdown?: XpBreakdown | null
}

// ─────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────

function safeMatchId(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null
}

function parseBreakdown(raw: string | null): XpBreakdown | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as XpBreakdown
  } catch {
    return null
  }
}

/** Build the award read-out from the two counter values. */
function toAward(
  amount: number,
  xpBefore: number,
  xpAfter: number,
  breakdown: XpBreakdown | null,
  cappedBy = 0
): XpAward {
  const levelBefore = levelFromXp(xpBefore)
  const levelAfter = levelFromXp(xpAfter)
  return {
    amount,
    xpBefore,
    xpAfter,
    levelBefore,
    levelAfter,
    leveledUp: levelAfter > levelBefore,
    level: getLevelInfo(xpAfter),
    breakdown,
    ...(cappedBy > 0 ? { cappedBy } : {}),
  }
}

// ─────────────────────────────────────────────────
// WRITE PATH
// ─────────────────────────────────────────────────

/**
 * How much of the daily self-reported allowance this wallet has left.
 * Returns the full cap when there is no db (nothing to meter against) and on
 * any query failure — a metering outage must not silently zero out XP for
 * three games.
 */
export async function selfReportedRemaining(wallet: string): Promise<number> {
  if (!db || !wallet) return SELF_REPORTED_DAILY_CAP
  try {
    const since = new Date(Date.now() - SELF_REPORTED_WINDOW_MS)
    const [row] = await db
      .select({
        total: sql<number>`coalesce(sum(${xpEvents.amount}), 0)`.mapWith(Number),
      })
      .from(xpEvents)
      .where(
        and(
          eq(xpEvents.wallet, wallet),
          eq(xpEvents.source, 'self_reported'),
          gte(xpEvents.createdAt, since)
        )
      )
    return Math.max(0, SELF_REPORTED_DAILY_CAP - (row?.total ?? 0))
  } catch (err) {
    console.error('[xpService] selfReportedRemaining failed:', err)
    return SELF_REPORTED_DAILY_CAP
  }
}

/**
 * Credit XP to one wallet and record the ledger row.
 *
 * Returns null (never throws) when there is no db, the amount rounds to zero,
 * or the wallet has no `users` row — an unregistered wallet has nowhere to
 * put progression, and inventing a row here would create accounts as a side
 * effect of playing.
 *
 * The daily cap is applied HERE rather than at the route, so it holds for
 * every self-reported path that might exist later.
 */
export async function awardXp(input: AwardXpInput): Promise<XpAward | null> {
  if (!db) return null

  const wallet = typeof input.wallet === 'string' ? input.wallet.trim() : ''
  if (!wallet) return null

  const source: XpSource = input.source === 'self_reported' ? 'self_reported' : 'match'
  let amount = Math.floor(Number(input.amount))
  if (!Number.isFinite(amount) || amount <= 0) return null

  let cappedBy = 0
  if (source === 'self_reported') {
    const remaining = await selfReportedRemaining(wallet)
    if (remaining <= 0) return null
    if (amount > remaining) {
      cappedBy = amount - remaining
      amount = remaining
    }
  }

  try {
    // Pure increment → race-free without a lock (see the header note).
    const [row] = await db
      .update(users)
      .set({ xp: sql`${users.xp} + ${amount}` })
      .where(eq(users.wallet, wallet))
      .returning({ xp: users.xp })

    // No row: the wallet has never signed in / has no account. Nothing to do.
    if (!row) return null

    const xpAfter = row.xp
    const xpBefore = Math.max(0, xpAfter - amount)
    const breakdown = input.breakdown ?? null
    const award = toAward(amount, xpBefore, xpAfter, breakdown, cappedBy)

    // Ledger row. Written after the counter so a failure here can only ever
    // lose the audit line, never the XP the player was told they earned.
    try {
      await db.insert(xpEvents).values({
        wallet,
        matchId: safeMatchId(input.matchId),
        gameKey: String(input.gameKey ?? '').trim().toLowerCase() || 'unknown',
        mode: String(input.mode ?? '').trim().toLowerCase() || 'unknown',
        amount,
        source,
        breakdown: breakdown ? JSON.stringify(breakdown) : null,
        xpBefore,
        xpAfter,
        levelBefore: award.levelBefore,
        levelAfter: award.levelAfter,
      })
    } catch (err) {
      console.error('[xpService] xp_events insert failed:', err)
    }

    return award
  } catch (err) {
    console.error('[xpService] awardXp failed:', err)
    return null
  }
}

/** A match result plus the wallet it belongs to — what awardMatchXp takes. */
export interface AwardMatchXpInput extends MatchXpInput {
  wallet: string
  matchId?: string | null
  source?: XpSource
}

/**
 * Score ONE finished match for ONE player and credit it.
 *
 * This is the function every game funnels through (statsService calls it for
 * every row it writes), which is what makes "every game awards XP" true by
 * construction instead of by nine call sites remembering to do it.
 */
export async function awardMatchXp(
  input: AwardMatchXpInput
): Promise<XpAward | null> {
  const breakdown = computeMatchXp(input)
  if (breakdown.total <= 0) return null
  return awardXp({
    wallet: input.wallet,
    amount: breakdown.total,
    gameKey: input.gameKey,
    mode: input.mode,
    matchId: input.matchId ?? null,
    source: input.source,
    breakdown,
  })
}

/**
 * Batch form for FFA / multi-player endings. Awards are independent (each is
 * its own row update), so one failure cannot take the rest down; the result
 * array keeps the input order with nulls where nothing was credited.
 */
export async function awardMatchXpBatch(
  inputs: AwardMatchXpInput[]
): Promise<(XpAward | null)[]> {
  if (!db || inputs.length === 0) return inputs.map(() => null)
  return Promise.all(inputs.map((input) => awardMatchXp(input)))
}

// ─────────────────────────────────────────────────
// READ PATH
// ─────────────────────────────────────────────────

/** The signed-in player's XP total, level, and recent awards. */
export async function getXpSummary(
  wallet: string,
  recentLimit = RECENT_EVENTS_DEFAULT
): Promise<XpSummary> {
  const empty: XpSummary = {
    xp: 0,
    level: getLevelInfo(0),
    recent: [],
    earnedToday: 0,
  }
  if (!db || !wallet) return empty

  const take = Math.min(
    Math.max(Math.floor(recentLimit) || 0, 1),
    RECENT_EVENTS_MAX
  )

  try {
    const [me] = await db
      .select({ xp: users.xp })
      .from(users)
      .where(eq(users.wallet, wallet))
      .limit(1)

    const xp = me?.xp ?? 0
    const since = new Date(Date.now() - SELF_REPORTED_WINDOW_MS)

    const [rows, [today]] = await Promise.all([
      db
        .select({
          gameKey: xpEvents.gameKey,
          mode: xpEvents.mode,
          amount: xpEvents.amount,
          source: xpEvents.source,
          breakdown: xpEvents.breakdown,
          levelBefore: xpEvents.levelBefore,
          levelAfter: xpEvents.levelAfter,
          createdAt: xpEvents.createdAt,
        })
        .from(xpEvents)
        .where(eq(xpEvents.wallet, wallet))
        .orderBy(desc(xpEvents.createdAt))
        .limit(take),
      db
        .select({
          total: sql<number>`coalesce(sum(${xpEvents.amount}), 0)`.mapWith(Number),
        })
        .from(xpEvents)
        .where(and(eq(xpEvents.wallet, wallet), gte(xpEvents.createdAt, since))),
    ])

    return {
      xp,
      level: getLevelInfo(xp),
      earnedToday: today?.total ?? 0,
      recent: rows.map((r) => ({
        gameKey: r.gameKey,
        mode: r.mode,
        amount: r.amount,
        source: (r.source === 'self_reported' ? 'self_reported' : 'match') as XpSource,
        breakdown: parseBreakdown(r.breakdown),
        levelBefore: r.levelBefore,
        levelAfter: r.levelAfter,
        leveledUp: r.levelAfter > r.levelBefore,
        createdAt: r.createdAt,
      })),
    }
  } catch (err) {
    console.error('[xpService] getXpSummary failed:', err)
    return empty
  }
}

/**
 * Top players by career XP (i.e. by level — ordering by one is ordering by
 * the other, which is why no level column exists).
 *
 * SECURITY: the projection is `users.username` only, exactly like
 * statsService.getLeaderboard. Unregistered accounts (null username) have no
 * public identity and never appear.
 *
 * There is deliberately no minimum-matches floor here: XP already IS a
 * measure of how much someone has played, so a small sample cannot flatter
 * anyone the way a 1-match 100% win rate can.
 */
export async function getXpLeaderboard(limit = 100): Promise<XpLeaderboardRow[]> {
  if (!db) return []

  const take = Math.min(
    Math.max(Math.floor(limit) || 0, 1),
    LEADERBOARD_MAX_LIMIT
  )

  try {
    const rows = await db
      .select({ username: users.username, xp: users.xp })
      .from(users)
      .where(and(isNotNull(users.username), sql`${users.xp} > 0`))
      .orderBy(desc(users.xp), users.username)
      .limit(take)

    return rows.map((r, i) => {
      const info = getLevelInfo(r.xp)
      return {
        rank: i + 1,
        username: r.username ?? '',
        xp: info.xp,
        level: info.level,
        band: info.band,
        color: info.color,
      }
    })
  } catch (err) {
    console.error('[xpService] getXpLeaderboard failed:', err)
    return []
  }
}
