import type { RankTier, RankDivision, RankInfo } from './types'

/**
 * RANK DERIVATION — Ranked 2.0 (RP → tier + division)
 * ═══════════════════════════════════════════════════
 * This file is the ONLY place a rank badge is computed. It is pure and
 * isomorphic (client + server import it from @neon/types).
 *
 * THE MODEL (see rankingLogic.md):
 *   • Hidden skill  = TrueSkill {mu, sigma}, server-side only, drives
 *     matchmaking and the size of an RP change (apps/server/src/services/
 *     trueskill.ts + rankService.ts).
 *   • Visible ladder = RP, a single integer that CHASES skill
 *     (`gap = 100 * mu - rp`).
 *   • The badge is DERIVED from RP alone — never stored. Change the
 *     thresholds here and every badge in the app moves with them.
 *
 * MMR = 100 × mu, so RP and skill live on the same 0–5000+ scale:
 * mu 25 (a new player) ≈ 2500 "skill RP"; mu 50 ≈ 5000 = Champion.
 */

// ─────────────────────────────────────────────────
// TIER ENTRY THRESHOLDS (RP)
// ─────────────────────────────────────────────────
/**
 * ⚠️ DELIBERATE RECONCILIATION OF A SPEC CONTRADICTION — read before editing.
 *
 * rankingLogic.md §4 asserts BOTH of these, and they cannot both be true:
 *   (a) "every tier has 5 divisions and EACH DIVISION IS EXACTLY 100 RP"
 *       → that would make every tier exactly 500 RP wide, and
 *   (b) the tier ENTRY table: 1000 / 1600 / 2100 / 2600 / 3200 / 4100 /
 *       4600 / 5000 → spans of 600, 500, 500, 600, 900, 500, 400.
 *
 * DECISION (pinned by the design contract): keep the ENTRY thresholds (b).
 * They anchor Champion at 5000 RP = mu 50, which the spec lists as
 * officially confirmed, and they encode the intended pacing (the wide
 * Platinum span exists precisely to slow the late climb — the reason
 * Emerald was inserted at all). Each tier's span is then split into FIVE
 * EQUAL divisions, so a division is ~80–180 RP instead of exactly 100.
 *
 * Consequence: NEVER hard-code 100 RP per division anywhere. Read the width
 * from DIVISION_WIDTH_RP (or RankInfo.rpForDivision), which is derived from
 * this table below.
 */
export const TIER_ENTRY_RP: Record<RankTier, number> = {
  Copper: 1000, // season start — everyone begins here (Copper V)
  Bronze: 1600,
  Silver: 2100,
  Gold: 2600,
  Platinum: 3200,
  Emerald: 4100, // inserted between Plat and Diamond to flatten the climb
  Diamond: 4600,
  Champion: 5000, // = mu 50; no divisions above this line
}

/** Back-compat alias — the old export name for the threshold table. */
export const RANK_THRESHOLDS: Record<RankTier, number> = TIER_ENTRY_RP

export const RANK_ORDER: RankTier[] = [
  'Copper',
  'Bronze',
  'Silver',
  'Gold',
  'Platinum',
  'Emerald',
  'Diamond',
  'Champion',
]

/** Divisions, BOTTOM first: index 0 = V (you enter a tier at V) … 4 = I. */
export const DIVISIONS: RankDivision[] = ['V', 'IV', 'III', 'II', 'I']
export const DIVISIONS_PER_TIER = DIVISIONS.length // 5

/** RP every player is reset to on a season rollover (= Copper V). */
export const SEASON_START_RP = TIER_ENTRY_RP.Copper // 1000
/** RP at which Champion begins (spec: mu 50 → 5000 MMR). */
export const CHAMPION_RP = TIER_ENTRY_RP.Champion // 5000
/** Hard floor for RP. Only reachable by losing at the very bottom of the
 *  ladder — the demotion shield stops every other fall at a tier floor. */
export const RP_FLOOR = 0
/** MMR = MMR_PER_MU × mu — puts skill on the RP scale so `gap` is a subtraction. */
export const MMR_PER_MU = 100

/**
 * Width of ONE division, per tier, in RP — DERIVED, not hand-written:
 * (next tier's entry − this tier's entry) / 5. Champion has no divisions
 * so its width is 0.
 */
export const DIVISION_WIDTH_RP: Record<RankTier, number> = RANK_ORDER.reduce(
  (acc, tier, i) => {
    const next = RANK_ORDER[i + 1]
    acc[tier] = next
      ? (TIER_ENTRY_RP[next] - TIER_ENTRY_RP[tier]) / DIVISIONS_PER_TIER
      : 0
    return acc
  },
  {} as Record<RankTier, number>
)
// Resulting widths: Copper 120, Bronze 100, Silver 100, Gold 120,
// Platinum 180, Emerald 100, Diamond 80, Champion — (none).

export const RANK_COLORS: Record<RankTier, string> = {
  Copper: '#b87333',
  Bronze: '#cd7f32',
  Silver: '#c0c0c0',
  Gold: '#ffd700',
  Platinum: '#e5e4e2',
  Emerald: '#50c878',
  Diamond: '#b9f2ff',
  Champion: '#ff4d94',
}

// Gradient backgrounds for rank cards in the UI
export const RANK_GRADIENTS: Record<RankTier, string> = {
  Copper: 'linear-gradient(135deg, #b87333, #8B4513)',
  Bronze: 'linear-gradient(135deg, #cd7f32, #a0522d)',
  Silver: 'linear-gradient(135deg, #c0c0c0, #808080)',
  Gold: 'linear-gradient(135deg, #ffd700, #b8860b)',
  Platinum: 'linear-gradient(135deg, #e5e4e2, #9e9e9e)',
  Emerald: 'linear-gradient(135deg, #50c878, #1a6b3a)',
  Diamond: 'linear-gradient(135deg, #b9f2ff, #4fc3f7)',
  Champion: 'linear-gradient(135deg, #ff4d94, #c62a6a)',
}

// ─────────────────────────────────────────────────
// BUCKETING HELPERS
// ─────────────────────────────────────────────────

/** The tier that owns this RP value. */
export function tierOf(rp: number): RankTier {
  let tier: RankTier = 'Copper'
  for (const candidate of RANK_ORDER) {
    if (rp >= TIER_ENTRY_RP[candidate]) tier = candidate
  }
  return tier
}

/**
 * RP floor of the tier containing `rp` — i.e. the RP you fall back to when
 * the demotion shield saves you. Copper's floor is 1000 (the season start),
 * so a Copper player who is already at the floor can still bleed below it
 * (there is no tier under Copper); RP_FLOOR = 0 is the absolute bottom.
 */
export function tierFloorRp(rp: number): number {
  return TIER_ENTRY_RP[tierOf(rp)]
}

/** RP at which `tier` `division` begins (Champion ignores `division`). */
export function divisionFloorRp(tier: RankTier, division: RankDivision): number {
  const index = DIVISIONS.indexOf(division)
  return TIER_ENTRY_RP[tier] + Math.max(0, index) * DIVISION_WIDTH_RP[tier]
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// ─────────────────────────────────────────────────
// GET RANK INFO — the full badge from an RP number
// ─────────────────────────────────────────────────
/**
 * `rp` is the visible ladder number (users.rp1v1 / users.rpFfa).
 *
 * Edge cases, all deliberate:
 *  • rp < 1000 (only reachable by losing at the very bottom of Copper) →
 *    Copper V at 0% progress. There is no tier below Copper to show.
 *  • Champion (rp ≥ 5000) → `division: null`, progress pinned at 100%.
 *    Champions are ordered by raw RP on the leaderboard, not by division.
 *  • Non-integer / NaN input is coerced to a safe integer.
 */
export function getRankInfo(rp: number): RankInfo {
  const safeRp = Number.isFinite(rp) ? Math.round(rp) : RP_FLOOR
  const clampedRp = Math.max(RP_FLOOR, safeRp)

  const tier = tierOf(clampedRp)
  const tierIndex = RANK_ORDER.indexOf(tier)
  const isMaxRank = tier === 'Champion'
  const nextTier: RankTier | null = isMaxRank ? null : RANK_ORDER[tierIndex + 1]

  const entry = TIER_ENTRY_RP[tier]
  const width = DIVISION_WIDTH_RP[tier]

  let division: RankDivision | null = null
  let rpIntoDivision = 0
  let rpForDivision = 0
  let progressPct = 100

  if (!isMaxRank && width > 0) {
    // Below Copper's entry we still render Copper V — clamp to the entry so
    // the division index can never go negative.
    const intoTier = Math.max(0, clampedRp - entry)
    const index = clamp(Math.floor(intoTier / width), 0, DIVISIONS_PER_TIER - 1)
    division = DIVISIONS[index]
    rpForDivision = width
    rpIntoDivision = clamp(intoTier - index * width, 0, width)
    progressPct = clamp(Math.round((rpIntoDivision / width) * 100), 0, 100)
  }

  const rpToNextTier = nextTier
    ? Math.max(0, TIER_ENTRY_RP[nextTier] - clampedRp)
    : 0

  return {
    tier,
    division,
    rp: clampedRp,
    rpIntoDivision,
    rpForDivision,
    progressPct,
    nextTier,
    rpToNextTier,
    color: RANK_COLORS[tier],
    gradient: RANK_GRADIENTS[tier],
    isMaxRank,
    label: division ? `${tier} ${division}` : tier,

    // legacy aliases (see RankInfo) — same numbers, old names
    elo: clampedRp,
    progress: progressPct,
    eloToNextRank: rpToNextTier,
  }
}

/** "SILVER III" / "CHAMPION" — the sidebar/badge caption. */
export function rankLabel(rp: number): string {
  return getRankInfo(rp).label.toUpperCase()
}

/** Formatted RP for display: 2,240 */
export function formatRp(rp: number): string {
  return Math.max(RP_FLOOR, Math.round(rp)).toLocaleString('en-US')
}

// ─────────────────────────────────────────────────
// TRANSITIONS — for rank-up / rank-down animations
// ─────────────────────────────────────────────────
/** True when the TIER went UP (Silver → Gold). Division promotions use
 *  didDivisionUp — they are far more frequent and deserve a smaller cue. */
export function didRankUp(oldRp: number, newRp: number): boolean {
  return (
    RANK_ORDER.indexOf(getRankInfo(newRp).tier) >
    RANK_ORDER.indexOf(getRankInfo(oldRp).tier)
  )
}

/** True when the TIER went DOWN (a demotion actually landed). */
export function didRankDown(oldRp: number, newRp: number): boolean {
  return (
    RANK_ORDER.indexOf(getRankInfo(newRp).tier) <
    RANK_ORDER.indexOf(getRankInfo(oldRp).tier)
  )
}

/** True when the badge changed at all (tier OR division). */
export function didDivisionChange(oldRp: number, newRp: number): boolean {
  const a = getRankInfo(oldRp)
  const b = getRankInfo(newRp)
  return a.tier !== b.tier || a.division !== b.division
}

// ─────────────────────────────────────────────────
// CHANGE LABEL — for UI display
// ─────────────────────────────────────────────────
export function rpChangeLabel(change: number): string {
  if (change > 0) return `+${change}`
  return String(change)
}

/** @deprecated renamed to `rpChangeLabel` — kept so old imports compile. */
export const eloChangeLabel = rpChangeLabel
