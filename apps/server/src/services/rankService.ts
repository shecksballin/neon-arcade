/**
 * RANK SERVICE — the visible RP ladder (Ranked 2.0)
 * ═════════════════════════════════════════════════
 * The ONLY place ratings are mutated under the new system. It owns both
 * layers of the model described in rankingLogic.md:
 *
 *   HIDDEN  {mu, sigma}  ← services/trueskill.ts, from the OUTCOME only
 *   VISIBLE  rp          ← this file: an integer that CHASES skill
 *
 * The link between them is one subtraction (§3.1):
 *
 *     gap = 100 * mu − rp        (+ = underranked, − = overranked)
 *
 * and the RP you win or lose is proportional to that gap (§3.3). That is the
 * whole trick: a smurf's skill rockets away from their RP, so `gap` is huge
 * and positive, so every win pays ~+80 while losses barely sting — they are
 * pulled up to where they belong in a handful of games. Someone who got
 * boosted has a negative gap and bleeds back down just as fast. A settled
 * player sits near gap ≈ 0 and trades ±30 forever.
 *
 * LADDERS (queues that own a {mu, sigma, rp} triple)
 *   '1v1' — chess, volley, connect, quiz 1v1
 *   'ffa' — quiz FFA, cells/asteroids LMS, cells/asteroids slayer
 *   FREE PLAY IS UNRANKED. It has no outcome, so nothing here may be called
 *   for it — free play must never move skill or RP. (Practice / local /
 *   vs-computer games never reach the server at all.)
 *
 * ATOMICITY — identical reasoning to the legacy eloService: ratings are
 * read-modify-write, so every settle runs in ONE transaction that locks the
 * affected `users` rows with SELECT … FOR UPDATE, acquired in wallet order
 * so two concurrent settlements can never deadlock. Because the row is
 * locked, we can write absolute values computed in JS (rather than SQL
 * arithmetic) and still be race-free.
 *
 * NULL-DB / ERROR POLICY — every exported function returns null (or an
 * empty/defaulted value) when `db` is null and NEVER throws into callers.
 * Game loops and disconnect handlers call these fire-and-forget: a rating
 * that fails to save is a logged annoyance, not a broken match.
 *
 * SEASON ROLLOVER is a manual, callable function — there is deliberately no
 * cron. To run it (see rolloverSeason below for what it does):
 *
 *   cd apps/server
 *   doppler run -- bun -e "import('./src/services/rankService').then(m => \
 *     m.rolloverSeason().then(r => console.log(r)))"
 */

import { asc, eq, inArray, sql } from 'drizzle-orm'
import {
  MMR_PER_MU,
  RP_FLOOR,
  SEASON_START_RP,
  getRankInfo,
  tierFloorRp,
  type RankInfo,
  type RankLadder,
  type SkillRating,
} from '@neon/types'
import { db } from '../db'
import { eloHistory, users } from '../db/schema'
import {
  SIGMA_0,
  defaultRating,
  rateFreeForAll,
  rateHeadToHead,
} from './trueskill'

// ─────────────────────────────────────────────────
// RP CONSTANTS (rankingLogic.md §3.3, pinned by the design contract)
// ─────────────────────────────────────────────────
/** Neutral RP swing at gap = 0 — a settled player trades ±30. */
export const RP_BASE = 30
/** How much gap (in RP) counts as "a full unit" of under/over-ranking. */
export const RP_GAP_SCALE = 1000
/** How far the gap can push a win up or a loss down. */
export const RP_SWING = 40
/** Floor on |RP change| for a decisive result — a match is never worthless. */
export const RP_MIN = 9
/** Cap on |RP change|. */
export const RP_MAX = 80
/** The normalised gap is clamped here, so the gap term maxes out at ±60 RP. */
export const RP_GAP_CLAMP = 1.5
/** Season rollover multiplies sigma by this (capped at SIGMA_0) so the
 *  system re-confirms where strong players belong (§5.1). */
export const SEASON_SIGMA_BUMP = 1.3

/** The two rating pools. Re-exported so callers need one import. */
export type Ladder = RankLadder

/** One player's full state on one ladder. Contains HIDDEN skill —
 *  never serialize this to a client. */
export interface LadderState extends SkillRating {
  rp: number
  season: number
}

/** What a settlement produces for one player. `wallet` is for the HANDLER's
 *  bookkeeping only — strip it before broadcasting to a room, and never
 *  broadcast `mu`/`sigma` either (see the schema note on users.mu_1v1). */
export interface RankedResult {
  wallet: string
  name: string
  ladder: Ladder
  outcome: 'win' | 'loss' | 'draw'
  placement: number | null

  rpBefore: number
  rp: number // rp AFTER — what the badge is drawn from
  rpChange: number

  muBefore: number
  mu: number
  sigmaBefore: number
  sigma: number

  rankBefore: RankInfo
  rank: RankInfo
  promoted: boolean // tier went up
  demoted: boolean // tier went down (shield did not save them)
  badgeChanged: boolean // tier OR division changed — worth an animation
  shielded: boolean // demotion shield clamped this loss at the tier floor

  /** @deprecated legacy mirror of `rp` for old `newRatings` payloads. */
  rating: number
  /** @deprecated legacy mirror of `rpChange`. */
  change: number
}

export interface Settle1v1RankedResult {
  a: RankedResult
  b: RankedResult
}

/** One competitor in an FFA settlement. Supply EITHER `placement` (1-based,
 *  equal values = tie) OR `score` (higher is better — placements are then
 *  derived with competition ranking, so ties share a placement). */
export interface RankedStanding {
  wallet: string
  placement?: number
  score?: number
  kills?: number
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * `elo_history.match_id` is a uuid column, but the 1v1 games identify a game
 * by a ROOM ID (e.g. "chess:ab12"), and a bad cast would abort the whole
 * settlement transaction — losing the rating over a bookkeeping field. So
 * anything that isn't a uuid is stored as null, exactly as statsService does.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function safeMatchId(matchId: string | null | undefined): string | null {
  return matchId && UUID_RE.test(matchId) ? matchId : null
}

// ─────────────────────────────────────────────────
// THE RP FORMULA
// ─────────────────────────────────────────────────

/**
 * The §3.3 reference formula, generalised from win/loss to a continuous
 * `resultWeight` in [−1, +1] so that FFA placements use the SAME curve:
 *
 *   +1 = an outright win (or first place in an FFA)
 *    0 = a draw / dead-centre finish
 *   −1 = an outright loss (or last place)
 *
 * change = BASE·weight + SWING·clamp(gap / GAP_SCALE, ±1.5)
 *
 * then the sign is enforced and the magnitude clamped into [RP_MIN, RP_MAX]:
 * a decisive win ALWAYS gains at least 9 RP and a decisive loss always costs
 * at least 9, no matter how extreme the gap.
 *
 * Sanity check against the spec's anchor table:
 *   gap +1000, win  → 30 + 40 = +70
 *   gap +1000, loss → −30 + 40 = +10 → sign-corrected and floored to −9
 *   gap     0       → +30 / −30
 *   gap −1000, win  → 30 − 40 = −10 → floored to +9
 *   gap −1000, loss → −30 − 40 = −70
 *
 * DRAWS (weight 0) deliberately skip the RP_MIN floor: a draw is not a
 * result, so it must not swing the ladder — it only nudges RP toward skill
 * by the gap term, and a settled player's draw is worth exactly 0 RP.
 */
export function rpDelta(resultWeight: number, gap: number): number {
  const weight = clamp(Number.isFinite(resultWeight) ? resultWeight : 0, -1, 1)
  const safeGap = Number.isFinite(gap) ? gap : 0
  const g = clamp(safeGap / RP_GAP_SCALE, -RP_GAP_CLAMP, RP_GAP_CLAMP)

  const raw = RP_BASE * weight + RP_SWING * g

  if (weight > 0) return Math.round(clamp(raw, RP_MIN, RP_MAX))
  if (weight < 0) return -Math.round(clamp(-raw, RP_MIN, RP_MAX))
  // Draw: pure convergence, no floor, still capped.
  return Math.round(clamp(raw, -RP_MAX, RP_MAX))
}

/** Win/loss shorthand for the 1v1 path (§3.3 verbatim). */
export function rpChange(won: boolean, gap: number): number {
  return rpDelta(won ? 1 : -1, gap)
}

/** Draw shorthand — moves RP toward skill only. */
export function rpChangeForDraw(gap: number): number {
  return rpDelta(0, gap)
}

/**
 * How "well" a placement did, as a weight in [−1, +1]: the share of the
 * field you beat minus the share that beat you. Tie-aware by construction —
 * if everyone shares a placement, everyone gets 0 (a draw), which the naive
 * (n − placement)/(n − 1) formula gets badly wrong.
 */
export function placementWeight(placement: number, placements: number[]): number {
  const n = placements.length
  if (n < 2) return 0
  let beaten = 0
  let lostTo = 0
  for (const p of placements) {
    if (p > placement) beaten++
    else if (p < placement) lostTo++
  }
  return (beaten - lostTo) / (n - 1)
}

/**
 * DEMOTION SHIELD (§5.2, tightened by the design contract).
 *
 * A single loss may not drop you out of your TIER if you entered the match
 * above its floor: the loss is clamped at the floor for that match instead.
 * Lose again from the floor and the demotion goes through for real — so a
 * demotion always costs you two bad games, never one unlucky one.
 *
 * `delta` must be negative; positive deltas are returned unchanged.
 */
export function applyRpLoss(rpBefore: number, delta: number): number {
  const raw = rpBefore + delta
  if (delta >= 0) return raw

  const floor = tierFloorRp(rpBefore)
  // Shielded: they were above the floor and this loss would cross it.
  if (rpBefore > floor && raw < floor) return floor
  // Already at/below the floor → real demotion (or the very bottom of the
  // ladder, where RP_FLOOR is the only backstop left).
  return Math.max(RP_FLOOR, raw)
}

/** Apply an RP change with the shield on the way down. There is no ceiling:
 *  Champion is open-ended so the leaderboard can order Champions by RP. */
export function applyRpChange(rpBefore: number, delta: number): number {
  return delta < 0 ? applyRpLoss(rpBefore, delta) : rpBefore + delta
}

/** Season rollover, as a pure function (§5.1): RP resets to Copper V, mu
 *  PERSISTS, sigma is bumped back toward its initial value. */
export function rolloverState(state: LadderState, toSeason: number): LadderState {
  return {
    mu: state.mu,
    sigma: Math.min(SIGMA_0, state.sigma * SEASON_SIGMA_BUMP),
    rp: SEASON_START_RP,
    season: toSeason,
  }
}

// ─────────────────────────────────────────────────
// DRIZZLE PLUMBING
// ─────────────────────────────────────────────────

type DbClient = NonNullable<typeof db>
type Tx = Parameters<Parameters<DbClient['transaction']>[0]>[0]
type UserRow = typeof users.$inferSelect
type UserPatch = Partial<typeof users.$inferInsert>
type HistoryInsert = typeof eloHistory.$inferInsert

/** Read one ladder's state out of a users row. */
function readState(row: UserRow, ladder: Ladder): LadderState {
  return ladder === '1v1'
    ? { mu: row.mu1v1, sigma: row.sigma1v1, rp: row.rp1v1, season: row.season }
    : { mu: row.muFfa, sigma: row.sigmaFfa, rp: row.rpFfa, season: row.season }
}

/**
 * The column patch for one ladder. NOTE the legacy mirror: `elo`/`eloFfa`
 * are written with the new RP so un-migrated readers (leaderboards, social
 * payloads) show the same number the badge is derived from. They are NOT
 * read back by anything in this file.
 */
function ladderPatch(
  ladder: Ladder,
  next: { mu: number; sigma: number; rp: number }
): UserPatch {
  return ladder === '1v1'
    ? { mu1v1: next.mu, sigma1v1: next.sigma, rp1v1: next.rp, elo: next.rp }
    : { muFfa: next.mu, sigmaFfa: next.sigma, rpFfa: next.rp, eloFfa: next.rp }
}

/**
 * Lock the users rows for `wallets` inside a transaction. ORDER BY wallet
 * makes every caller acquire row locks in the same global order — the
 * classic deadlock-avoidance trick when two settlements touch overlapping
 * row sets at the same time.
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
 * Turn one player's (before → after) skill move into an RP move: writes the
 * `users` row and RETURNS the history row for the caller to insert in one
 * batch (an FFA lobby would otherwise do 20 separate INSERTs).
 */
async function settlePlayer(
  tx: Tx,
  row: UserRow,
  ladder: Ladder,
  before: LadderState,
  afterSkill: SkillRating,
  weight: number,
  ctx: {
    gameKey: string
    mode: string
    matchId: string | null
    placement: number | null
    kills: number
  }
): Promise<{ result: RankedResult; history: HistoryInsert }> {
  // §6 step 2: the gap is measured against the UPDATED skill, so a
  // surprising result is felt in the very match that produced it.
  const gap = MMR_PER_MU * afterSkill.mu - before.rp
  const delta = rpDelta(weight, gap)

  const unshielded = before.rp + delta
  const rpAfter = applyRpChange(before.rp, delta)
  const shielded = delta < 0 && rpAfter !== unshielded

  const outcome: RankedResult['outcome'] =
    weight > 0 ? 'win' : weight < 0 ? 'loss' : 'draw'

  const rankBefore = getRankInfo(before.rp)
  const rank = getRankInfo(rpAfter)

  await tx
    .update(users)
    .set(ladderPatch(ladder, { mu: afterSkill.mu, sigma: afterSkill.sigma, rp: rpAfter }))
    .where(eq(users.wallet, row.wallet))

  const history: HistoryInsert = {
    matchId: safeMatchId(ctx.matchId),
    wallet: row.wallet,
    gameKey: ctx.gameKey,
    mode: ctx.mode,
    // legacy mirror — kept in lockstep so `before + change === after` holds
    eloBefore: before.rp,
    eloAfter: rpAfter,
    eloChange: rpAfter - before.rp,
    ladder,
    result: outcome,
    rpBefore: before.rp,
    rpAfter,
    rpChange: rpAfter - before.rp,
    muBefore: before.mu,
    muAfter: afterSkill.mu,
    sigmaBefore: before.sigma,
    sigmaAfter: afterSkill.sigma,
    shielded,
    season: before.season,
    kills: ctx.kills,
    placement: ctx.placement,
  }

  const result: RankedResult = {
    wallet: row.wallet,
    name: row.username ?? 'Player',
    ladder,
    outcome,
    placement: ctx.placement,
    rpBefore: before.rp,
    rp: rpAfter,
    rpChange: rpAfter - before.rp,
    muBefore: before.mu,
    mu: afterSkill.mu,
    sigmaBefore: before.sigma,
    sigma: afterSkill.sigma,
    rankBefore,
    rank,
    promoted: rank.tier !== rankBefore.tier && rpAfter > before.rp,
    demoted: rank.tier !== rankBefore.tier && rpAfter < before.rp,
    badgeChanged:
      rank.tier !== rankBefore.tier || rank.division !== rankBefore.division,
    shielded,
    rating: rpAfter,
    change: rpAfter - before.rp,
  }

  return { result, history }
}

// ─────────────────────────────────────────────────
// SETTLEMENT — 1v1
// ─────────────────────────────────────────────────

/**
 * Settle a finished RANKED 1v1 (chess / volley / connect / quiz 1v1) on the
 * '1v1' ladder.
 *
 *   outcome 'a'    → aWallet won
 *   outcome 'b'    → bWallet won
 *   outcome 'draw' → chess/connect draw: TrueSkill's drawn update, and RP
 *                    moves only toward skill.
 *
 * `matchId` is optional — the 1v1 games don't create a `matches` row, so
 * eloHistory.matchId stays null for them.
 *
 * Returns null (never throws) when there is no db, when either wallet has no
 * users row, or on any failure. NEVER call this for free play or for a
 * game against the computer.
 */
export async function settleRanked1v1(
  gameKey: string,
  aWallet: string,
  bWallet: string,
  outcome: 'a' | 'b' | 'draw',
  matchId: string | null = null
): Promise<Settle1v1RankedResult | null> {
  if (!db) return null // no database → games still play, ratings skipped
  if (!aWallet || !bWallet || aWallet === bWallet) return null // self-play is unrated

  try {
    return await db.transaction(async (tx) => {
      const rows = await lockUserRows(tx, [aWallet, bWallet])
      const aRow = rows.find((r) => r.wallet === aWallet)
      const bRow = rows.find((r) => r.wallet === bWallet)
      if (!aRow || !bRow) {
        // Ranked games require registered accounts, so this "can't happen" —
        // but a missing row must not throw into the game handler.
        console.error('[rankService] settleRanked1v1: missing users row(s)', {
          gameKey,
        })
        return null
      }

      const beforeA = readState(aRow, '1v1')
      const beforeB = readState(bRow, '1v1')

      // 1. HIDDEN: TrueSkill from the outcome only.
      const skill = rateHeadToHead(beforeA, beforeB, outcome)

      // 2. VISIBLE: RP from the skill↔rank gap.
      const weightA = outcome === 'draw' ? 0 : outcome === 'a' ? 1 : -1
      const ctx = { gameKey, mode: '1v1', matchId, placement: null, kills: 0 }

      const a = await settlePlayer(tx, aRow, '1v1', beforeA, skill.a, weightA, ctx)
      const b = await settlePlayer(tx, bRow, '1v1', beforeB, skill.b, -weightA, ctx)

      await tx.insert(eloHistory).values([a.history, b.history])

      return { a: a.result, b: b.result }
    })
  } catch (err) {
    console.error('[rankService] settleRanked1v1 failed:', err)
    return null
  }
}

// ─────────────────────────────────────────────────
// SETTLEMENT — N-way free-for-all
// ─────────────────────────────────────────────────

/**
 * Settle a finished RANKED free-for-all on the 'ffa' ladder.
 *
 * `mode` is a LABEL for history only ('ffa' | 'quiz_ffa' | 'lms' | 'slayer');
 * every FFA mode shares one rating pool.
 *
 *   LMS    — order by finishing placement (1 = last one standing).
 *   SLAYER — order by KILL COUNT, ties sharing a placement. ⚠️ Slayer still
 *            shows "no winner" on the results screen; the ordering exists
 *            ONLY to feed the rating model, nobody is crowned. This is a
 *            judgement call the owner should confirm.
 *   QUIZ   — order by score.
 *
 * Standings may carry `placement` directly, or a `score` (higher is better)
 * from which competition-ranked placements are derived. Only wallets that
 * have a `users` row are rated, and weights are computed within that rated
 * subset so an unregistered participant can't inflate anyone's payout.
 *
 * Returns one entry per rated participant, ordered by placement, or null.
 */
export async function settleRankedFfa(
  gameKey: string,
  standings: RankedStanding[],
  matchId: string | null = null,
  mode: string = 'ffa'
): Promise<RankedResult[] | null> {
  if (!db) return null
  if (standings.length < 2) return null // no field → nothing to rate

  try {
    return await db.transaction(async (tx) => {
      // De-duplicate defensively: one row per wallet, first occurrence wins.
      const unique: RankedStanding[] = []
      const seen = new Set<string>()
      for (const s of standings) {
        if (!s.wallet || seen.has(s.wallet)) continue
        seen.add(s.wallet)
        unique.push(s)
      }
      if (unique.length < 2) return null

      const rows = await lockUserRows(
        tx,
        unique.map((s) => s.wallet)
      )
      const byWallet = new Map(rows.map((r) => [r.wallet, r]))
      const rated = unique.filter((s) => byWallet.has(s.wallet))
      if (rated.length < 2) return null // need two rated players for a result

      // Placements: use what the caller gave us, else competition-rank the
      // scores (1 + the number of players who scored strictly higher), which
      // makes equal scores share a placement — a genuine tie.
      const placementOf = new Map<string, number>()
      for (const s of rated) {
        if (typeof s.placement === 'number' && Number.isFinite(s.placement)) {
          placementOf.set(s.wallet, s.placement)
        } else {
          const score = s.score ?? 0
          placementOf.set(
            s.wallet,
            1 + rated.filter((o) => (o.score ?? 0) > score).length
          )
        }
      }

      const ordered = [...rated].sort(
        (x, y) => placementOf.get(x.wallet)! - placementOf.get(y.wallet)!
      )
      const placements = ordered.map((s) => placementOf.get(s.wallet)!)

      // 1. HIDDEN: one N-way TrueSkill update over the whole field.
      //    (Default 'full' pairwise reduction — see rateFreeForAll for why
      //    the adjacent-only chain freezes mid-table players' skill.)
      const beforeStates = ordered.map((s) =>
        readState(byWallet.get(s.wallet)!, 'ffa')
      )
      const afterSkill = rateFreeForAll(
        ordered.map((s, i) => ({
          rating: beforeStates[i],
          placement: placementOf.get(s.wallet)!,
        }))
      )

      // 2. VISIBLE: RP per player, from their own gap and their placement.
      const results: RankedResult[] = []
      const history: HistoryInsert[] = []
      for (let i = 0; i < ordered.length; i++) {
        const s = ordered[i]
        const placement = placementOf.get(s.wallet)!
        const settled = await settlePlayer(
          tx,
          byWallet.get(s.wallet)!,
          'ffa',
          beforeStates[i],
          afterSkill[i],
          placementWeight(placement, placements),
          {
            gameKey,
            mode,
            matchId,
            placement,
            // quiz FFA passes correct answers here; slayer passes kills.
            kills: s.kills ?? 0,
          }
        )
        results.push(settled.result)
        history.push(settled.history)
      }

      await tx.insert(eloHistory).values(history)

      return results
    })
  } catch (err) {
    console.error('[rankService] settleRankedFfa failed:', err)
    return null
  }
}

// ─────────────────────────────────────────────────
// READ HELPERS (matchmaking + profile)
// ─────────────────────────────────────────────────

/**
 * Hidden skill for a set of wallets — what the MATCHMAKER pairs on (§5.3).
 * ALWAYS returns an entry for every wallet asked for: an unknown wallet (or
 * a server running without a database) gets the default {25, 8.33}, so the
 * queue never has to special-case a missing rating.
 */
export async function getSkills(
  wallets: string[],
  ladder: Ladder
): Promise<Map<string, SkillRating>> {
  const out = new Map<string, SkillRating>()
  for (const w of wallets) out.set(w, defaultRating())
  if (!db || wallets.length === 0) return out

  try {
    const rows = await db
      .select({
        wallet: users.wallet,
        mu1v1: users.mu1v1,
        sigma1v1: users.sigma1v1,
        muFfa: users.muFfa,
        sigmaFfa: users.sigmaFfa,
      })
      .from(users)
      .where(inArray(users.wallet, wallets))

    for (const r of rows) {
      out.set(
        r.wallet,
        ladder === '1v1'
          ? { mu: r.mu1v1, sigma: r.sigma1v1 }
          : { mu: r.muFfa, sigma: r.sigmaFfa }
      )
    }
  } catch (err) {
    console.error('[rankService] getSkills failed:', err)
  }
  return out
}

/** Hidden skill for ONE wallet (defaults when unknown / no db). */
export async function getSkill(
  wallet: string,
  ladder: Ladder
): Promise<SkillRating> {
  const map = await getSkills([wallet], ladder)
  return map.get(wallet) ?? defaultRating()
}

/** Full ladder state for one wallet, or null when there is no row / no db. */
export async function getLadderState(
  wallet: string,
  ladder: Ladder
): Promise<LadderState | null> {
  if (!db) return null
  try {
    const [row] = await db.select().from(users).where(eq(users.wallet, wallet)).limit(1)
    return row ? readState(row, ladder) : null
  } catch (err) {
    console.error('[rankService] getLadderState failed:', err)
    return null
  }
}

/** CLIENT-SAFE rank snapshot: RP + derived badge for both ladders, no
 *  hidden skill. Safe to serialize straight into an API response. */
export interface RankSummary {
  season: number
  oneVOne: { rp: number; rank: RankInfo }
  ffa: { rp: number; rank: RankInfo }
}

export async function getRankSummary(wallet: string): Promise<RankSummary | null> {
  if (!db) return null
  try {
    const [row] = await db
      .select({
        season: users.season,
        rp1v1: users.rp1v1,
        rpFfa: users.rpFfa,
      })
      .from(users)
      .where(eq(users.wallet, wallet))
      .limit(1)
    if (!row) return null
    return {
      season: row.season,
      oneVOne: { rp: row.rp1v1, rank: getRankInfo(row.rp1v1) },
      ffa: { rp: row.rpFfa, rank: getRankInfo(row.rpFfa) },
    }
  } catch (err) {
    console.error('[rankService] getRankSummary failed:', err)
    return null
  }
}

// ─────────────────────────────────────────────────
// SEASON ROLLOVER (§5.1) — MANUAL trigger, no cron
// ─────────────────────────────────────────────────

export interface SeasonRolloverResult {
  /** The season number every player is now on. */
  season: number
  /** How many user rows were reset. */
  playersReset: number
}

/**
 * Roll every player into the next season, in ONE statement:
 *   • RP → 1000 (Copper V) on BOTH ladders, and the legacy mirror with it;
 *   • mu PERSISTS — the system does not forget how good you are;
 *   • sigma ← min(SIGMA_0, sigma × 1.3) so it re-confirms strong players
 *     quickly (this, plus the resulting huge positive gap, is what makes the
 *     early-season climb fast);
 *   • season += 1.
 * There are NO placement matches by design (§5.1) — the skill↔rank gap does
 * the calibration implicitly from match one.
 *
 * Pass `toSeason` to force a specific number (e.g. re-running a botched
 * rollover); omit it to increment. Returns null when there is no db.
 */
export async function rolloverSeason(opts?: {
  toSeason?: number
}): Promise<SeasonRolloverResult | null> {
  if (!db) return null
  try {
    const nextSeason =
      typeof opts?.toSeason === 'number' && Number.isFinite(opts.toSeason)
        ? sql`${Math.floor(opts.toSeason)}`
        : sql`${users.season} + 1`

    const updated = await db
      .update(users)
      .set({
        rp1v1: SEASON_START_RP,
        rpFfa: SEASON_START_RP,
        // Explicit casts: the bound parameters would otherwise arrive as
        // Postgres "unknown" inside least(), which is fragile.
        sigma1v1: sql`least(cast(${SIGMA_0} as double precision), ${users.sigma1v1} * cast(${SEASON_SIGMA_BUMP} as double precision))`,
        sigmaFfa: sql`least(cast(${SIGMA_0} as double precision), ${users.sigmaFfa} * cast(${SEASON_SIGMA_BUMP} as double precision))`,
        // legacy mirror, kept in lockstep with rp (see ladderPatch)
        elo: SEASON_START_RP,
        eloFfa: SEASON_START_RP,
        season: nextSeason,
        // NOTE: `xp` is deliberately absent and must stay that way. XP is a
        // career total, not a rating — it survives every rollover (see
        // services/xpService.ts and the users.xp comment in db/schema.ts).
      })
      .returning({ season: users.season })

    const season = updated.reduce((max, r) => Math.max(max, r.season), 0)
    console.log(
      `[rankService] season rollover complete → season ${season} (${updated.length} players)`
    )
    return { season, playersReset: updated.length }
  } catch (err) {
    console.error('[rankService] rolloverSeason failed:', err)
    return null
  }
}
