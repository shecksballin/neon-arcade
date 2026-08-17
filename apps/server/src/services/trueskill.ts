/**
 * TRUESKILL — the hidden skill engine
 * ═══════════════════════════════════
 * A self-contained implementation of the TrueSkill™ rating update
 * (Herbrich, Minka & Graepel, Microsoft Research), written from the
 * pseudocode in rankingLogic.md §2.3. NO DEPENDENCY: the standard-normal
 * pdf / cdf / inverse-cdf are implemented here by hand.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Every player carries a normal distribution over their "true skill":
 *   mu    — best estimate of skill
 *   sigma — how UNCERTAIN that estimate is
 * A match result shifts mu (toward the winner) and shrinks sigma. Two
 * properties fall out of the maths for free and are the whole point:
 *   1. SURPRISE scales the update — beating a much stronger opponent moves
 *      mu a lot; an expected win barely moves it.
 *   2. CONFIDENCE dampens it — a low-sigma veteran's rating hardly twitches,
 *      a fresh account's swings hard.
 *
 * WHAT IT IS *NOT* FOR
 * --------------------
 * Skill updates on MATCH OUTCOME ONLY. Kills, score, damage, correct
 * answers — none of them feed this. (Placement in an FFA mode IS an
 * outcome: it is the ordering of the players, not a performance metric.)
 * The visible RP ladder is a separate layer entirely — see rankService.ts.
 *
 * Nothing in this file touches the database or throws; it is pure maths and
 * is safe to unit-test in isolation.
 */

import type { SkillRating } from '@neon/types'

// ─────────────────────────────────────────────────
// CONSTANTS (rankingLogic.md §2.1, pinned by the design contract)
// ─────────────────────────────────────────────────
/** Initial mean skill. MMR = 100 × mu, so a new player sits at 2500 MMR. */
export const MU_0 = 25.0
/** Initial uncertainty (≈8.333). Shrinks as the player plays. */
export const SIGMA_0 = 25.0 / 3
/** Per-game performance noise (≈4.167). Higher beta → ratings move less. */
export const BETA = 25.0 / 6
/** Additive dynamics factor (≈0.083): sigma is inflated by this before every
 *  update so a player who genuinely improves can still be tracked, and sigma
 *  never collapses to zero and freezes a rating forever. */
export const TAU = 25.0 / 300
/** Default draw probability. Siege ranked has no draws and neither do most
 *  of our modes, so the win/loss path uses 0 (⇒ draw margin 0). */
export const DRAW_PROBABILITY = 0.0
/**
 * Draw probability used ONLY when a result actually IS a draw (chess and
 * connect can draw; a tie on kills in slayer shares a placement).
 * A draw update is undefined at a draw margin of exactly 0 — the
 * truncated-Gaussian correction degenerates to 0/0 — so drawn outcomes are
 * evaluated with a small but non-zero margin. 0.10 ⇒ "about one game in ten
 * between evenly matched players ends level", which is roughly true of the
 * two games we have that can draw.
 */
export const DRAWN_OUTCOME_PROBABILITY = 0.1

/** A fresh, unrated player. */
export function defaultRating(): SkillRating {
  return { mu: MU_0, sigma: SIGMA_0 }
}

/** MMR as the spec defines it — puts skill on the RP scale (§3.1). */
export function mmr(rating: SkillRating): number {
  return 100 * rating.mu
}

/** Conservative skill estimate (mu − k·sigma): what you would sort a
 *  leaderboard by if you wanted to be sure someone earned their spot. */
export function conservativeSkill(rating: SkillRating, k = 3): number {
  return rating.mu - k * rating.sigma
}

// ─────────────────────────────────────────────────
// STANDARD NORMAL — pdf, cdf, inverse cdf (no dependency)
// ─────────────────────────────────────────────────

/** φ(x): standard-normal probability density. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

/**
 * Complementary error function erfc(x) = 1 − erf(x).
 * Chebyshev-fitted rational approximation (Numerical Recipes 3rd ed.,
 * `erfc`), relative error < ~1e-15 — far more accurate than the usual
 * Abramowitz & Stegun 7.1.26 fit, and it matters: the cdf appears in a
 * denominator below, so cheap approximations produce visible rating drift
 * in lopsided matches.
 */
export function erfc(x: number): number {
  const COF = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
    5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11,
    2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13,
    3.81e-16, 7.106e-15,
  ]
  const z = Math.abs(x)
  const t = 2 / (2 + z)
  const ty = 4 * t - 2
  let d = 0
  let dd = 0
  for (let j = COF.length - 1; j > 0; j--) {
    const tmp = d
    d = ty * d - dd + COF[j]
    dd = tmp
  }
  const ans = t * Math.exp(-z * z + 0.5 * (COF[0] + ty * d) - dd)
  return x >= 0 ? ans : 2 - ans
}

/** Φ(x): standard-normal cumulative distribution. */
export function normCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2)
}

/**
 * Φ⁻¹(p): inverse standard-normal cdf (the "probit"/ppf).
 * Peter Acklam's rational approximation, |relative error| < 1.15e-9.
 * Only used to turn a draw PROBABILITY into a draw MARGIN in skill units.
 */
export function normPpf(p: number): number {
  if (!(p > 0) || !(p < 1)) {
    // Guard: a caller asking for the 0th or 100th percentile gets a finite,
    // very large value instead of ±Infinity poisoning every later term.
    return p <= 0 ? -8 : 8
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ]
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ]
  const pLow = 0.02425
  const pHigh = 1 - pLow

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
  const q = p - 0.5
  const r = q * q
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  )
}

// ─────────────────────────────────────────────────
// TRUNCATED-GAUSSIAN CORRECTION TERMS (v and w)
// ─────────────────────────────────────────────────
// These are the heart of the update. `v` is how far the mean of the
// performance difference must move to be consistent with the observed
// result; `w` is how much variance that observation removes. Everything
// below works on t = (muWinner − muLoser) / c, i.e. the standardised skill
// difference, with `eps` the draw margin on the same scale.

/** Numerical guard: a cdf can underflow to 0 for |t| ≳ 38, which would make
 *  v = pdf/cdf explode into NaN. Below this we use the known asymptote. */
const TINY = 1e-300

/** v for a decisive result (the winner won). */
function vWin(t: number, eps: number): number {
  const x = t - eps
  const denom = normCdf(x)
  // As x → −∞ (a huge upset) v → −x: the update is large but stays finite.
  return denom > TINY ? normPdf(x) / denom : -x
}

/** w for a decisive result. Always in [0, 1]. */
function wWin(t: number, eps: number): number {
  const x = t - eps
  const denom = normCdf(x)
  if (denom <= TINY) return x < 0 ? 1 : 0
  const v = normPdf(x) / denom
  return v * (v + x)
}

/** v for a draw. Note the SIGN: if the favourite (t > 0) draws, v is
 *  negative — a draw against a weaker opponent costs the favourite mu. */
function vDraw(t: number, eps: number): number {
  const absT = Math.abs(t)
  const a = eps - absT
  const b = -eps - absT
  const denom = normCdf(a) - normCdf(b)
  if (denom <= TINY) return t < 0 ? -t - eps : -t + eps
  const numer = normPdf(b) - normPdf(a)
  return (numer / denom) * (t < 0 ? -1 : 1)
}

/** w for a draw. Always in [0, 1]. */
function wDraw(t: number, eps: number): number {
  const absT = Math.abs(t)
  const a = eps - absT
  const b = -eps - absT
  const denom = normCdf(a) - normCdf(b)
  if (denom <= TINY) return 1
  const v = vDraw(absT, eps)
  return v * v + (a * normPdf(a) - b * normPdf(b)) / denom
}

/**
 * The draw margin in raw skill units, derived from a draw probability
 * (standard TrueSkill: eps = Φ⁻¹((p+1)/2) · √n · beta). p = 0 ⇒ eps = 0,
 * which is exactly what a game with no draws wants.
 */
export function drawMargin(drawProbability: number, totalPlayers: number): number {
  return normPpf((drawProbability + 1) / 2) * Math.sqrt(totalPlayers) * BETA
}

// ─────────────────────────────────────────────────
// THE UPDATE
// ─────────────────────────────────────────────────

/** Step 1 of §2.3: inflate uncertainty a touch for dynamics. Done EXACTLY
 *  ONCE per match, before any comparison — not once per pairing. */
function inflate(r: SkillRating): SkillRating {
  return { mu: r.mu, sigma: Math.sqrt(r.sigma * r.sigma + TAU * TAU) }
}

/** Defensive normaliser: a corrupt/missing row must not produce NaN ratings.
 *  A bad sigma is repaired WITHOUT discarding a perfectly good mu. */
function sanitize(r: SkillRating | null | undefined): SkillRating {
  const mu = r && Number.isFinite(r.mu) ? r.mu : MU_0
  const sigma = r && Number.isFinite(r.sigma) && r.sigma > 0 ? r.sigma : SIGMA_0
  return { mu, sigma }
}

export type MatchOutcome = 'a' | 'b' | 'draw'

/**
 * TWO-TEAM UPDATE — rankingLogic.md §2.3, generalised to allow a draw.
 *
 *   c   = √(varA + varB + n·beta²)     total variance incl. performance noise
 *   t   = (muA − muB) / c              standardised skill difference
 *   v,w = truncated-Gaussian corrections for the observed outcome
 *   each player: mu ±= (sigma²/c)·v, sigma ← √(sigma²·(1 − (sigma²/c²)·w))
 *
 * The (sigma²/c) weighting is what distributes the team's adjustment back to
 * its members in proportion to how uncertain each of them is: the newbie on
 * the roster absorbs most of the change, the veteran barely moves.
 *
 * `teamA` / `teamB` are returned in the SAME ORDER they were passed.
 * Both arrays must be non-empty; anything else is returned untouched.
 */
export function rateTwoTeams(
  teamA: SkillRating[],
  teamB: SkillRating[],
  outcome: MatchOutcome
): { a: SkillRating[]; b: SkillRating[] } {
  if (teamA.length === 0 || teamB.length === 0) {
    return { a: teamA.map(sanitize), b: teamB.map(sanitize) }
  }

  // 1. dynamics inflation
  const a = teamA.map((r) => inflate(sanitize(r)))
  const b = teamB.map((r) => inflate(sanitize(r)))

  // 2. team aggregates
  const muA = a.reduce((s, p) => s + p.mu, 0)
  const muB = b.reduce((s, p) => s + p.mu, 0)
  const varA = a.reduce((s, p) => s + p.sigma * p.sigma, 0)
  const varB = b.reduce((s, p) => s + p.sigma * p.sigma, 0)

  const n = a.length + b.length
  const c = Math.sqrt(varA + varB + n * BETA * BETA)
  const drawn = outcome === 'draw'
  const eps = drawMargin(drawn ? DRAWN_OUTCOME_PROBABILITY : DRAW_PROBABILITY, n) / c

  // 3. orient the comparison so `t` is (winner − loser); for a draw the
  //    orientation is arbitrary and the sign of v handles the direction.
  const aWon = outcome !== 'b'
  const t = ((aWon ? muA - muB : muB - muA)) / c

  const v = drawn ? vDraw(t, eps) : vWin(t, eps)
  const w = drawn ? wDraw(t, eps) : wWin(t, eps)

  // 4. push each player toward / away from the result
  const up = (p: SkillRating) => step(p, c, v, w, +1)
  const down = (p: SkillRating) => step(p, c, v, w, -1)

  return aWon
    ? { a: a.map(up), b: b.map(down) }
    : { a: a.map(down), b: b.map(up) }
}

/** Apply the per-player mu shift and sigma shrink. `sign` is +1 for the
 *  side `t` was oriented toward, −1 for the other. */
function step(
  p: SkillRating,
  c: number,
  v: number,
  w: number,
  sign: 1 | -1
): SkillRating {
  const variance = p.sigma * p.sigma
  const mu = p.mu + sign * (variance / c) * v
  // (1 − (sigma²/c²)·w) is mathematically in (0, 1]; clamp anyway so float
  // noise can never hand Math.sqrt a negative number.
  const shrink = Math.max(1e-9, 1 - (variance / (c * c)) * w)
  return { mu, sigma: Math.sqrt(variance * shrink) }
}

/** Convenience wrapper for the 1v1 games (chess / volley / connect / quiz 1v1). */
export function rateHeadToHead(
  a: SkillRating,
  b: SkillRating,
  outcome: MatchOutcome
): { a: SkillRating; b: SkillRating } {
  const res = rateTwoTeams([a], [b], outcome)
  return { a: res.a[0], b: res.b[0] }
}

// ─────────────────────────────────────────────────
// N-WAY FREE-FOR-ALL
// ─────────────────────────────────────────────────

/** One competitor in a free-for-all. `placement` is 1-based; EQUAL
 *  placements mean a tie (drawn) between those players. */
export interface FfaCompetitor {
  rating: SkillRating
  placement: number
}

/**
 * How an N-way result is reduced to pairwise TrueSkill comparisons.
 *
 *  'full'     — compare EVERY pair, average the results (DEFAULT).
 *  'adjacent' — compare only neighbouring placements (1st↔2nd, 2nd↔3rd, …).
 *
 * See rateFreeForAll for why 'full' is the default. Both are single-pass and
 * order-independent.
 */
export type FfaPairing = 'full' | 'adjacent'

/**
 * N-WAY FREE-FOR-ALL UPDATE (each player is their own team of one).
 *
 * WHY THIS SHAPE — documenting the choice, as the design contract asks.
 *
 * Real TrueSkill models an N-way result as a factor graph with a comparison
 * node between each ADJACENT pair in the finishing order, then iterates
 * message passing until it converges. Implementing that loop is a lot of
 * machinery, so the standard shortcut is to reduce the ranking to a set of
 * INDEPENDENT pairwise updates and sum them in one pass. There are two
 * well-known ways to pick those pairs (they are the "partial pairing" and
 * "full pairing" variants of the Thurstone–Mosteller model that OpenSkill
 * ships), and BOTH are implemented here:
 *
 *   'adjacent'  1st ── 2nd ── 3rd ── 4th     (neighbours only, the chain
 *                                             that mirrors the factor graph)
 *   'full'      every pair, deltas averaged  (÷ n−1, see below)
 *
 * ⚠️ WHY 'full' IS THE DEFAULT — the chain has a failure mode that matters
 * for our lobbies. In a single pass, a mid-table player gets one push DOWN
 * from the player above and one push UP from the player below, and in an
 * evenly-matched lobby those cancel EXACTLY. Simulated: a player who
 * finishes 2nd of 8 every single game keeps mu = 25.000 forever while sigma
 * collapses to ~1.6 — the model becomes confidently wrong, and because RP
 * chases 100·mu their visible rank would stall around 2500 RP no matter how
 * well they play. Only the winner and the wooden-spoon holder ever move.
 * (Iterated message passing fixes this; a single pass over the chain does
 * not.) With full pairing the same player converges to mu ≈ 35 → ~3500 RP,
 * which is the behaviour the two-layer design needs.
 *
 * THE ÷(n−1) NORMALISATION. Full pairing gives each player n−1 comparisons,
 * so summing them raw would move a 20-player lobby's winner by ~+80 mu in
 * ONE game and crush sigma to 0.5. Averaging instead ("your rating moves by
 * the mean of your pairwise updates") keeps ONE MATCH WORTH ONE MATCH: with
 * n = 2 the divisor is 1, so a duel reduces EXACTLY to the two-team update,
 * and in an 8-player lobby first place moves +4.2 mu — the same as winning a
 * 1v1 — while the places in between move by graded amounts. Sigma shrinks a
 * touch more slowly than in a 1v1, which is the conservative direction.
 *
 * Ties (equal placements) use the DRAW update, which is how slayer kill-count
 * ties land here.
 *
 * Every delta is computed from the SAME pre-match (tau-inflated) ratings and
 * then combined, so the result never depends on the order pairs are visited
 * in. Cost is O(n²) comparisons for 'full' — trivial for 4–20 player lobbies.
 *
 * Returns new ratings in the SAME ORDER as the input array.
 */
export function rateFreeForAll(
  competitors: FfaCompetitor[],
  opts?: { pairing?: FfaPairing }
): SkillRating[] {
  const clean = competitors.map((c) => sanitize(c.rating))
  if (competitors.length < 2) return clean

  const pairing: FfaPairing = opts?.pairing ?? 'full'

  // 1. dynamics inflation — once, up front (NOT once per comparison).
  const base = clean.map(inflate)
  const n = base.length

  // 2. sort INDICES by placement (1 = best). Stable, so equal placements
  //    keep their input order and produce deterministic pairings.
  const order = competitors.map((_, i) => i)
  order.sort((x, y) => competitors[x].placement - competitors[y].placement)

  // 3. build the comparison list [betterIndex, worseIndex].
  const pairs: Array<[number, number]> = []
  if (pairing === 'adjacent') {
    for (let k = 0; k + 1 < n; k++) pairs.push([order[k], order[k + 1]])
  } else {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) pairs.push([order[i], order[j]])
    }
  }

  // Averaging weight — see the ÷(n−1) note above. 'adjacent' is already at
  // most two comparisons per player, so it is left unscaled.
  const weight = pairing === 'full' ? 1 / (n - 1) : 1

  const muDelta = new Array<number>(n).fill(0)
  const varFactor = new Array<number>(n).fill(1)

  for (const [iBetter, iWorse] of pairs) {
    const better = base[iBetter]
    const worse = base[iWorse]
    const drawn =
      competitors[iBetter].placement === competitors[iWorse].placement

    // Two "teams" of one player each → n = 2 in the variance term.
    const c = Math.sqrt(
      better.sigma * better.sigma + worse.sigma * worse.sigma + 2 * BETA * BETA
    )
    const eps =
      drawMargin(drawn ? DRAWN_OUTCOME_PROBABILITY : DRAW_PROBABILITY, 2) / c
    const t = (better.mu - worse.mu) / c
    const v = drawn ? vDraw(t, eps) : vWin(t, eps)
    const w = drawn ? wDraw(t, eps) : wWin(t, eps)

    muDelta[iBetter] += weight * ((better.sigma * better.sigma) / c) * v
    muDelta[iWorse] -= weight * ((worse.sigma * worse.sigma) / c) * v
    varFactor[iBetter] *= Math.max(
      1e-9,
      1 - weight * ((better.sigma * better.sigma) / (c * c)) * w
    )
    varFactor[iWorse] *= Math.max(
      1e-9,
      1 - weight * ((worse.sigma * worse.sigma) / (c * c)) * w
    )
  }

  // 4. apply the accumulated deltas.
  return base.map((p, i) => ({
    mu: p.mu + muDelta[i],
    sigma: Math.sqrt(p.sigma * p.sigma * varFactor[i]),
  }))
}

// ─────────────────────────────────────────────────
// MATCHMAKING HELPERS
// ─────────────────────────────────────────────────

/**
 * P(team A beats team B) under the TrueSkill model. The matchmaker's goal is
 * to get this as close to 0.5 as possible (§5.3).
 */
export function winProbability(
  teamA: SkillRating[],
  teamB: SkillRating[]
): number {
  if (teamA.length === 0 || teamB.length === 0) return 0.5
  const a = teamA.map(sanitize)
  const b = teamB.map(sanitize)
  const muA = a.reduce((s, p) => s + p.mu, 0)
  const muB = b.reduce((s, p) => s + p.mu, 0)
  const varAll =
    a.reduce((s, p) => s + p.sigma * p.sigma, 0) +
    b.reduce((s, p) => s + p.sigma * p.sigma, 0)
  const n = a.length + b.length
  const c = Math.sqrt(varAll + n * BETA * BETA)
  return normCdf((muA - muB) / c)
}

/**
 * Match quality in [0, 1] for a 1v1 pairing — 1.0 is a perfect coin flip.
 * Handy if the matchmaker ever wants to rank candidate pairings by more
 * than |mu difference| (uncertainty counts: two unsure players are a
 * better gamble than one veteran vs one unknown).
 */
export function matchQuality1v1(a: SkillRating, b: SkillRating): number {
  const x = sanitize(a)
  const y = sanitize(b)
  const twoBetaSq = 2 * BETA * BETA
  const varSum = x.sigma * x.sigma + y.sigma * y.sigma
  const denom = twoBetaSq + varSum
  const dMu = x.mu - y.mu
  return Math.sqrt(twoBetaSq / denom) * Math.exp(-(dMu * dMu) / (2 * denom))
}
