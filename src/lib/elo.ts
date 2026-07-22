import type { RankTier, RankInfo } from '../types'

// ─────────────────────────────────────────────────
// RANK THRESHOLDS
// Every 100 ELO = one rank up
// Starting ELO for new players: 0
// ─────────────────────────────────────────────────
export const RANK_THRESHOLDS: Record<RankTier, number> = {
  Copper:   0,
  Bronze:   100,
  Silver:   200,
  Gold:     300,
  Platinum: 400,
  Emerald:  500,
  Diamond:  600,
  Champion: 700,
}

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

export const RANK_COLORS: Record<RankTier, string> = {
  Copper:   '#b87333',
  Bronze:   '#cd7f32',
  Silver:   '#c0c0c0',
  Gold:     '#ffd700',
  Platinum: '#e5e4e2',
  Emerald:  '#50c878',
  Diamond:  '#b9f2ff',
  Champion: '#ff4d94',
}

// Gradient backgrounds for rank cards in the UI
export const RANK_GRADIENTS: Record<RankTier, string> = {
  Copper:   'linear-gradient(135deg, #b87333, #8B4513)',
  Bronze:   'linear-gradient(135deg, #cd7f32, #a0522d)',
  Silver:   'linear-gradient(135deg, #c0c0c0, #808080)',
  Gold:     'linear-gradient(135deg, #ffd700, #b8860b)',
  Platinum: 'linear-gradient(135deg, #e5e4e2, #9e9e9e)',
  Emerald:  'linear-gradient(135deg, #50c878, #1a6b3a)',
  Diamond:  'linear-gradient(135deg, #b9f2ff, #4fc3f7)',
  Champion: 'linear-gradient(135deg, #ff4d94, #c62a6a)',
}

// ─────────────────────────────────────────────────
// GET RANK INFO — full rank object from an ELO number
// ─────────────────────────────────────────────────
export function getRankInfo(elo: number): RankInfo {
  const clampedElo = Math.max(0, elo)

  // Find current tier
  let tier: RankTier = 'Copper'
  for (const rank of RANK_ORDER) {
    if (clampedElo >= RANK_THRESHOLDS[rank]) {
      tier = rank
    }
  }

  const tierIndex = RANK_ORDER.indexOf(tier)
  const isMaxRank = tier === 'Champion'

  const currentThreshold = RANK_THRESHOLDS[tier]
  const nextThreshold     = isMaxRank
    ? currentThreshold + 100
    : RANK_THRESHOLDS[RANK_ORDER[tierIndex + 1]]

  const progressElo  = clampedElo - currentThreshold
  const rangeElo     = nextThreshold - currentThreshold
  const progress     = Math.min(100, Math.round((progressElo / rangeElo) * 100))
  const eloToNextRank = isMaxRank ? 0 : nextThreshold - clampedElo

  return {
    tier,
    elo:          clampedElo,
    progress,
    eloToNextRank,
    isMaxRank,
    color:        RANK_COLORS[tier],
  }
}

// ─────────────────────────────────────────────────
// DID RANK UP — compare old vs new ELO
// Used to trigger rank-up animation/notification
// ─────────────────────────────────────────────────
export function didRankUp(oldElo: number, newElo: number): boolean {
  return getRankInfo(oldElo).tier !== getRankInfo(newElo).tier
}

// ─────────────────────────────────────────────────
// ELO CHANGE LABEL — for UI display
// ─────────────────────────────────────────────────
export function eloChangeLabel(change: number): string {
  if (change > 0) return `+${change}`
  return String(change)
}
