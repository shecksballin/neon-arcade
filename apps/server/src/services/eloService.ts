/**
 * ELO SERVICE — now the RANK WIRE ADAPTER (+ legacy compatibility shim)
 * =====================================================================
 * THIS FILE NO LONGER COMPUTES RATINGS.
 *
 * The naive single-number ELO that used to live here (K=32 1v1 / K=16 FFA /
 * K=12 per free-play kill, ranks every 100 points from 0) is gone. Ratings
 * are now the two-layer Ranked 2.0 model in `services/rankService.ts`:
 *
 *   HIDDEN  {mu, sigma}  — TrueSkill, from the MATCH OUTCOME only
 *   VISIBLE  rp          — an integer that CHASES skill (gap = 100·mu − rp)
 *
 * What survives here is the part the socket handlers actually needed from
 * this module, and nothing else:
 *
 *   1. `publicRating()` — the ONE place a `RankedResult` is turned into
 *      something safe to put on the wire. A RankedResult carries `wallet`,
 *      `mu` and `sigma`; all three are server-only (wallets are never leaked
 *      to opponents, and the hidden skill layer is hidden on purpose). Every
 *      game module projects through this before broadcasting.
 *   2. `settle1v1` / `settleFfa` — the OLD function names, kept as thin
 *      deprecated forwarders onto rankService so nothing that still imports
 *      them silently keeps writing the old maths (they don't — they write RP).
 *   3. `freeplayKill` — kept ONLY as a documented no-op. See below.
 *
 * ── FREE PLAY IS UNRANKED (binding contract) ─────────────────────────────
 * The permanent cells/asteroids world used to move `users.eloFfa` on every
 * kill. It must not: free play has no outcome, no match, and no end — rating
 * a kill there means a player can farm rank forever in a mode nobody can
 * lose. `freeplayKill` is therefore a no-op that returns null, and the only
 * call site (socket/freeplay/world.ts) has been removed. Practice, local and
 * vs-computer games never reach the server at all and are likewise unranked.
 *
 * Which results DO feed the ladder now (and where they are settled):
 *   chess / connect / volley / quiz 1v1  → rankService.settleRanked1v1 ('1v1')
 *   quiz FFA                             → rankService.settleRankedFfa ('ffa')
 *   cells / asteroids LMS                → settleRankedFfa, ordered by place
 *   cells / asteroids SLAYER             → settleRankedFfa, ordered by KILLS
 *
 * NULL-DB / ERROR POLICY is inherited from rankService: every call returns
 * null when there is no database and NEVER throws into a game loop.
 */

import type { RankInfo } from '@neon/types'
import {
  settleRanked1v1,
  settleRankedFfa,
  type RankedResult,
  type RankedStanding,
} from './rankService'

// Re-exported so a handler needs one import for "the standings shape".
export type { RankedResult, RankedStanding }

// ---------------------------------------------------------------------------
// THE WIRE PROJECTION
// ---------------------------------------------------------------------------

/**
 * A settled player's rating, SAFE TO BROADCAST.
 *
 * Deliberately additive over the old `{ name, rating, change }` payload that
 * every shipped client reads today:
 *   - `rating` / `change` are kept as the legacy mirrors of `rp` / `rpChange`,
 *     so an un-migrated client keeps rendering exactly what it rendered before
 *     (it just sees RP numbers now instead of ELO numbers);
 *   - everything else is new and optional from the client's point of view —
 *     `rank` / `rankBefore` carry the derived badge (tier + division + colours)
 *     so the results screen can animate a promotion without a second request.
 *
 * NOT present, on purpose: `wallet` (never leaked to opponents) and
 * `mu`/`sigma` (the hidden skill layer stays hidden — showing it would let
 * players reverse-engineer matchmaking and would make RP look like a lie).
 */
export interface PublicRating {
  /** Registered username — the only public identifier we have. */
  name: string
  /** @deprecated legacy mirror of `rp`, for clients that predate Ranked 2.0. */
  rating: number
  /** @deprecated legacy mirror of `rpChange`. */
  change: number

  rp: number
  rpChange: number
  rpBefore: number
  outcome: 'win' | 'loss' | 'draw'
  /** 1-based finishing position (FFA); null for a plain 1v1 verdict. */
  placement: number | null

  /** Badge BEFORE and AFTER — derived from RP alone, never stored. */
  rankBefore: RankInfo
  rank: RankInfo
  /** Tier went up / down. */
  promoted: boolean
  demoted: boolean
  /** Tier OR division changed — i.e. the badge art changed, worth animating. */
  badgeChanged: boolean
  /** The demotion shield clamped this loss at the tier floor. */
  shielded: boolean
}

/** `PublicRating` plus the wallet, for a HANDLER's own bookkeeping. Strip the
 *  wallet (use `publicRating`) before anything reaches a room. */
export interface RatedStanding extends PublicRating {
  wallet: string
}

/**
 * @deprecated Old name for `PublicRating`. Kept so `newRatings` payload types
 * in the game modules didn't all have to be renamed in one go.
 */
export type RatingAfter = PublicRating

/**
 * Project a settlement result onto the wire. THE choke point: if a field is
 * not listed here it does not reach a client, which is what keeps `wallet`,
 * `mu` and `sigma` server-side by construction rather than by discipline.
 */
export function publicRating(r: RankedResult): PublicRating {
  return {
    name: r.name,
    rating: r.rp, // legacy mirror
    change: r.rpChange, // legacy mirror
    rp: r.rp,
    rpChange: r.rpChange,
    rpBefore: r.rpBefore,
    outcome: r.outcome,
    placement: r.placement,
    rankBefore: r.rankBefore,
    rank: r.rank,
    promoted: r.promoted,
    demoted: r.demoted,
    badgeChanged: r.badgeChanged,
    shielded: r.shielded,
  }
}

/** Same projection, keeping the wallet for handler-side bookkeeping. */
export function ratedStanding(r: RankedResult): RatedStanding {
  return { ...publicRating(r), wallet: r.wallet }
}

// ---------------------------------------------------------------------------
// LEGACY FORWARDERS — old names, new maths
// ---------------------------------------------------------------------------

export interface Settle1v1Result {
  a: PublicRating
  b: PublicRating
}

/**
 * @deprecated Call `rankService.settleRanked1v1` directly and project with
 * `publicRating`. Kept because the signature is identical, so anything that
 * still calls `settle1v1(gameKey, aWallet, bWallet, result)` keeps working —
 * it just settles RP + TrueSkill instead of the old K=32 ELO.
 */
export async function settle1v1(
  gameKey: string,
  aWallet: string,
  bWallet: string,
  result: 'a' | 'b' | 'draw',
  matchId: string | null = null
): Promise<Settle1v1Result | null> {
  const settled = await settleRanked1v1(gameKey, aWallet, bWallet, result, matchId)
  if (!settled) return null
  return { a: publicRating(settled.a), b: publicRating(settled.b) }
}

/** @deprecated Old FFA standing shape. `score` is still "higher is better". */
export interface FfaStanding {
  wallet: string
  score: number
  kills?: number
}

/** @deprecated Old FFA result shape — now `RatedStanding`. */
export type FfaRatingResult = RatedStanding

/**
 * @deprecated Call `rankService.settleRankedFfa` directly and project with
 * `publicRating` / `ratedStanding`.
 */
export async function settleFfa(
  gameKey: string,
  standings: FfaStanding[],
  matchId: string | null = null,
  mode: string = 'ffa'
): Promise<FfaRatingResult[] | null> {
  const settled = await settleRankedFfa(gameKey, standings, matchId, mode)
  return settled ? settled.map(ratedStanding) : null
}

/** @deprecated Legacy shape of the (now removed) per-kill free-play payout. */
export interface FreeplayKillResult {
  killer: PublicRating
  victim: PublicRating
}

/**
 * FREE PLAY IS UNRANKED — this is a permanent NO-OP.
 *
 * It used to apply a K=12 ELO swing to `users.eloFfa` on every kill in the
 * permanent cells/asteroids world. Under Ranked 2.0 that is forbidden twice
 * over: skill updates come from a MATCH OUTCOME only (never from kills), and
 * free play has no match and no outcome to begin with. Ranked kill-count
 * scoring lives in SLAYER, which is a match with a start, an end and a field
 * to be ranked against.
 *
 * Kept (rather than deleted) so any straggler caller fails loudly in review
 * rather than quietly at runtime: it compiles, returns null, and writes
 * nothing.
 */
export async function freeplayKill(
  _killerWallet: string,
  _victimWallet: string,
  _gameKey: string = 'freeplay',
  _matchId: string | null = null
): Promise<FreeplayKillResult | null> {
  return null
}
