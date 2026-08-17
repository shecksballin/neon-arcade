/**
 * XP + LEVELS — the progression layer (every game, every mode)
 * ════════════════════════════════════════════════════════════
 * This file is the ONLY place a level or an XP award is computed. It is pure
 * and isomorphic (client + server import it from @neon/types), exactly like
 * elo.ts is for rank badges.
 *
 * HOW IT RELATES TO RANK — they are deliberately different things:
 *
 *   RP / RANK   how GOOD you are. Zero-sum, seasonal, ranked matches only,
 *               can go DOWN, split across two ladders (1v1 / ffa).
 *   XP / LEVEL  how MUCH you have played. Monotonic (never falls), never
 *               resets on a season rollover, ONE number across the whole
 *               arcade, and EVERY game awards it — free play, slayer and the
 *               single-player iframe games included. Losing still pays.
 *
 * That split is the point: a new player can watch their level climb from
 * their first match while their RP is still deciding what it thinks of them.
 *
 * LEVEL IS DERIVED FROM XP AND NEVER STORED — same rule as the rank badge.
 * The database keeps `users.xp` only; change the curve below and every level
 * in the app moves with it.
 */

// ─────────────────────────────────────────────────
// THE CURVE — "harder as they go", written as one formula
// ─────────────────────────────────────────────────
/**
 * XP needed to advance FROM level L to level L+1:
 *
 *     cost(L) = round25( CURVE_BASE × L ^ CURVE_EXPONENT )
 *
 * A superlinear exponent is what makes each level harder than the last: the
 * cost of a level grows with the level you are already on, so the same match
 * moves the bar visibly at level 3 and barely at level 80.
 *
 * Why a POWER curve and not the other two obvious choices:
 *   • linear (cost = k·L) never really slows down — level 90 costs 90× level
 *     1, which players clear in a weekend of grinding.
 *   • exponential (cost = k·rᴸ) slows down far too fast: at r = 1.15 level 60
 *     costs ~4,400× level 1 and the ladder becomes decoration.
 *   A ~1.25 exponent sits between them — every level costs about 25% more
 *   effort per level than a flat ladder would, compounding smoothly.
 *
 * Anchors (exact, from LEVEL_THRESHOLDS below), against a typical ~150 XP
 * ranked win — "cumulative" is the career XP at which that level begins:
 *
 *   level   2   step      100 XP   ·  cumulative         100  (~1 match)
 *   level  10   step    1,775 XP   ·  cumulative       7,075  (~47 matches)
 *   level  25   step    5,600 XP   ·  cumulative      59,350  (~400 matches)
 *   level  50   step   13,300 XP   ·  cumulative     288,825  (~1,900 matches)
 *   level  75   step   22,075 XP   ·  cumulative     724,675  (~4,800 matches)
 *   level 100   step        —      ·  cumulative   1,389,625  (~9,300 matches)
 *
 * Note the shape: the first ten levels cost less than half of level 50 alone.
 */
export const CURVE_BASE = 100
export const CURVE_EXPONENT = 1.25

/** Costs are rounded to this so the UI never shows "1,778 XP to go". */
const CURVE_ROUNDING = 25

/** The ceiling. At MAX_LEVEL the meter reads 100% and XP still accumulates. */
export const MAX_LEVEL = 100

/** The level every account starts at (0 XP). */
export const MIN_LEVEL = 1

/**
 * Cost of the step FROM `level` to `level + 1`. Zero at (and above) MAX_LEVEL
 * — there is nothing left to buy.
 */
export function xpToAdvance(level: number): number {
  const l = Math.floor(level)
  if (!Number.isFinite(l) || l < MIN_LEVEL || l >= MAX_LEVEL) return 0
  const raw = CURVE_BASE * l ** CURVE_EXPONENT
  return Math.round(raw / CURVE_ROUNDING) * CURVE_ROUNDING
}

/**
 * CUMULATIVE XP thresholds, index = level. `LEVEL_THRESHOLDS[n]` is the total
 * career XP at which level `n` begins (so [1] === 0).
 *
 * Built once at module load — 100 multiplications — so `levelFromXp` is a
 * scan over a small array rather than a loop of `**` calls on every render.
 * Index 0 is unused padding so the array can be indexed by level directly.
 */
export const LEVEL_THRESHOLDS: number[] = (() => {
  const out = [0, 0]
  for (let level = MIN_LEVEL; level < MAX_LEVEL; level++) {
    out[level + 1] = out[level] + xpToAdvance(level)
  }
  return out
})()

/** Total career XP required to REACH `level` (level 1 → 0). */
export function totalXpForLevel(level: number): number {
  const l = Math.floor(level)
  if (!Number.isFinite(l) || l <= MIN_LEVEL) return 0
  if (l >= MAX_LEVEL) return LEVEL_THRESHOLDS[MAX_LEVEL]
  return LEVEL_THRESHOLDS[l]
}

/** XP at which the ladder tops out — the cost of everything up to MAX_LEVEL. */
export const MAX_LEVEL_XP = LEVEL_THRESHOLDS[MAX_LEVEL]

/**
 * The level a career XP total buys. Negative/NaN input floors at MIN_LEVEL,
 * anything past the top of the curve is MAX_LEVEL.
 */
export function levelFromXp(xp: number): number {
  const safe = Number.isFinite(xp) ? Math.floor(xp) : 0
  if (safe <= 0) return MIN_LEVEL
  if (safe >= MAX_LEVEL_XP) return MAX_LEVEL
  // Linear scan from the top: levels are cheap early, so most players sit in
  // the first quarter of the array and a scan from MAX_LEVEL down is O(few).
  for (let level = MAX_LEVEL; level > MIN_LEVEL; level--) {
    if (safe >= LEVEL_THRESHOLDS[level]) return level
  }
  return MIN_LEVEL
}

// ─────────────────────────────────────────────────
// BANDS — a name and a colour for the level, for the UI
// ─────────────────────────────────────────────────
/**
 * Purely cosmetic. Bands get WIDER as they go, which is the same statement
 * the curve makes — you spend far longer inside "Veteran" than "Rookie".
 */
export interface LevelBand {
  /** Lowest level in the band. */
  from: number
  name: string
  color: string
}

export const LEVEL_BANDS: LevelBand[] = [
  { from: 1, name: 'Rookie', color: '#7dd3fc' },
  { from: 10, name: 'Runner', color: '#00ffd1' },
  { from: 25, name: 'Veteran', color: '#a78bfa' },
  { from: 45, name: 'Elite', color: '#fbbf24' },
  { from: 65, name: 'Master', color: '#fb7185' },
  { from: 85, name: 'Legend', color: '#f472b6' },
  { from: MAX_LEVEL, name: 'Ascendant', color: '#ffffff' },
]

/** The band a level falls in (always resolves — level 1 hits the first). */
export function bandOf(level: number): LevelBand {
  let band = LEVEL_BANDS[0]
  for (const candidate of LEVEL_BANDS) {
    if (level >= candidate.from) band = candidate
  }
  return band
}

// ─────────────────────────────────────────────────
// LEVEL INFO — everything the UI needs, from XP alone
// ─────────────────────────────────────────────────
export interface LevelInfo {
  /** Career XP (clamped to >= 0). */
  xp: number
  level: number
  /** XP earned inside the current level. */
  xpIntoLevel: number
  /** Width of the current level in XP (0 at MAX_LEVEL). */
  xpForLevel: number
  /** XP still needed for the next level (0 at MAX_LEVEL). */
  xpToNextLevel: number
  /** 0–100 across the CURRENT level. Pinned at 100 for a max-level account. */
  progressPct: number
  isMaxLevel: boolean
  /** Cosmetic band name ("Veteran") and its colour. */
  band: string
  color: string
  /** "LEVEL 24" — the caption every surface prints. */
  label: string
}

/**
 * Everything about a player's progression, derived from their XP total.
 *
 * Edge cases, all deliberate:
 *  • xp <= 0 (a brand-new account) → level 1 at 0% progress, never a divide
 *    by zero and never NaN.
 *  • MAX_LEVEL → `xpForLevel` / `xpToNextLevel` are 0 and progress pins at
 *    100%; the XP number itself keeps climbing so the leaderboard can still
 *    order two max-level players.
 *  • Non-integer / NaN input is coerced to a safe integer.
 */
export function getLevelInfo(xp: number): LevelInfo {
  const safeXp = Math.max(0, Number.isFinite(xp) ? Math.floor(xp) : 0)
  const level = levelFromXp(safeXp)
  const isMaxLevel = level >= MAX_LEVEL

  const floor = totalXpForLevel(level)
  const xpForLevel = isMaxLevel ? 0 : xpToAdvance(level)
  const xpIntoLevel = isMaxLevel ? 0 : Math.max(0, safeXp - floor)
  const xpToNextLevel = isMaxLevel ? 0 : Math.max(0, xpForLevel - xpIntoLevel)
  const progressPct = isMaxLevel
    ? 100
    : xpForLevel > 0
      ? Math.min(100, Math.max(0, Math.round((xpIntoLevel / xpForLevel) * 100)))
      : 0

  const band = bandOf(level)

  return {
    xp: safeXp,
    level,
    xpIntoLevel,
    xpForLevel,
    xpToNextLevel,
    progressPct,
    isMaxLevel,
    band: band.name,
    color: band.color,
    label: `Level ${level}`,
  }
}

/** True when this XP gain crossed at least one level boundary. */
export function didLevelUp(xpBefore: number, xpAfter: number): boolean {
  return levelFromXp(xpAfter) > levelFromXp(xpBefore)
}

/** Formatted XP for display: 12,480 */
export function formatXp(xp: number): string {
  return Math.max(0, Math.round(Number.isFinite(xp) ? xp : 0)).toLocaleString(
    'en-US'
  )
}

/** "+150 XP" — the award toast/caption. */
export function xpGainLabel(amount: number): string {
  return `+${formatXp(amount)} XP`
}

// ═════════════════════════════════════════════════
// AWARDS — what one finished match is worth
// ═════════════════════════════════════════════════
/**
 * THE RULE THIS ENCODES: **every game awards XP**. There is no game and no
 * mode that pays nothing — that is what separates XP from RP, which only
 * moves on ranked matches.
 *
 * The server is AUTHORITATIVE (services/xpService.ts calls this on the same
 * input it writes to `match_results`); the client imports it only to preview
 * a number. Never trust a client-computed award.
 */

/** Turning up at all. Free play is worth less — sessions are short and a
 *  player can start one every few seconds. */
export const XP_PARTICIPATION = 50
export const XP_PARTICIPATION_FREEPLAY = 15

/** Outcome bonuses. A LOSS still pays: the ladder measures time invested,
 *  and a mode where losing is worth nothing teaches people to quit early. */
export const XP_WIN = 100
export const XP_DRAW = 40
export const XP_LOSS = 15

/** Per kill, and the ceiling on kill XP from one match (a long free-play run
 *  in Cells can otherwise out-earn a hundred ranked matches). */
export const XP_PER_KILL = 5
export const XP_KILLS_CAP = 150

/** FFA podium, for modes that have a placement but no winner (slayer, LMS).
 *  Index 0 = 1st. A player whose `result` is already 'win' does NOT collect
 *  1st place on top of the win bonus. */
export const XP_PLACEMENT = [60, 30, 15]

/** In-game score converted to XP, and its ceiling. */
export const XP_PER_SCORE_POINT = 1 / 100
export const XP_SCORE_CAP = 50

/**
 * A match shorter than this pays NO participation/outcome XP (kills and score
 * still count). Rejoining a lobby over and over is the cheapest XP farm there
 * is; 15 seconds is under any real match and over any farm loop.
 */
export const XP_MIN_DURATION_MS = 15_000

/** Hard ceiling on a single match, whatever the maths says. */
export const XP_MATCH_CAP = 400

/** The `mode` marker for free play (mirrors statsService.FREEPLAY_MODE). */
const FREEPLAY_MODE = 'freeplay'

/** What `computeMatchXp` needs — a subset of a stats row. */
export interface MatchXpInput {
  gameKey: string
  mode: string
  /** 'none' for modes with no win condition (free play, slayer). */
  result: 'win' | 'loss' | 'draw' | 'none'
  kills?: number
  deaths?: number
  score?: number
  /** 1-based FFA finishing position. */
  placement?: number | null
  durationMs?: number | null
}

/** One line of the award, so the UI can show WHY a number is what it is. */
export interface XpBreakdown {
  participation: number
  outcome: number
  kills: number
  placement: number
  score: number
  /** Sum of the lines above, before the match cap. */
  subtotal: number
  /** What is actually awarded (subtotal, capped at XP_MATCH_CAP). */
  total: number
  /** True when the match was too short to pay participation/outcome. */
  tooShort: boolean
}

const int = (v: unknown): number => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * XP for ONE player's result in ONE match. Pure — no I/O, safe to call in a
 * loop over an FFA standings table.
 *
 * Deaths are deliberately NOT penalised. XP measures play, not skill; RP is
 * where dying costs you something.
 */
export function computeMatchXp(input: MatchXpInput): XpBreakdown {
  const mode = String(input.mode ?? '').toLowerCase()
  const isFreeplay = mode === FREEPLAY_MODE

  // The anti-farm guard. `durationMs` is optional: a caller that does not
  // know how long the match ran gets the benefit of the doubt.
  const duration = input.durationMs
  const tooShort =
    typeof duration === 'number' &&
    Number.isFinite(duration) &&
    duration < XP_MIN_DURATION_MS

  const participation = tooShort
    ? 0
    : isFreeplay
      ? XP_PARTICIPATION_FREEPLAY
      : XP_PARTICIPATION

  let outcome = 0
  if (!tooShort) {
    if (input.result === 'win') outcome = XP_WIN
    else if (input.result === 'draw') outcome = XP_DRAW
    else if (input.result === 'loss') outcome = XP_LOSS
    // 'none' (free play / slayer) has no outcome to pay for — participation,
    // kills and placement carry those modes.
  }

  const kills = Math.min(int(input.kills) * XP_PER_KILL, XP_KILLS_CAP)

  // 1st place is already paid for by XP_WIN in modes that have a winner.
  const place = input.placement
  const placement =
    typeof place === 'number' && place >= 1 && place <= XP_PLACEMENT.length
      ? input.result === 'win' && place === 1
        ? 0
        : XP_PLACEMENT[place - 1]
      : 0

  const score = Math.min(
    Math.floor(int(input.score) * XP_PER_SCORE_POINT),
    XP_SCORE_CAP
  )

  const subtotal = participation + outcome + kills + placement + score

  return {
    participation,
    outcome,
    kills,
    placement,
    score,
    subtotal,
    total: Math.min(subtotal, XP_MATCH_CAP),
    tooShort,
  }
}
