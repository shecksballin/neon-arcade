# Rainbow Six Siege — Ranked 2.0 System

## An Implementation Specification for Developers

This document describes how Rainbow Six Siege's **Ranked 2.0** system works with
enough precision to **re-implement it**. It separates what Ubisoft has publicly
confirmed from the parts you have to reconstruct, and gives concrete formulas,
parameters, and pseudocode you can build against.

> **Scope note.** This covers *Ranked 2.0* (introduced Y7S4, December 2022;
> Emerald tier and refinements landed in Y8S3). Ubisoft shipped **Ranked 3.0**
> in 2026 which tweaks the skill model and tier layout. The two-layer
> architecture below is the same in both; if you want to match the newest live
> numbers, treat this as the reference design and adjust the constants.

---

## 1. The core idea: two decoupled numbers

The single most important design decision in Ranked 2.0 is that it splits the
old single MMR into **two separate values** that serve different purposes:

| Layer | Name | Visible? | Purpose | Updated by |
|-------|------|----------|---------|------------|
| Hidden | **Skill** (μ, σ) | No | Matchmaking — balance teams by win probability | Match outcome only |
| Visible | **Rank Points (RP)** | Yes | Ladder progression — the rank badge players see | A function of the Skill↔Rank gap |

A player's **Skill** is a statistical estimate of their true ability. Their
**Rank/RP** is a ladder position that *chases* their Skill over time. You never
match players by RP; you match by Skill. RP exists purely so the visible climb
feels earned and gradual.

Everything else in the system falls out of this split.

---

## 2. The hidden Skill engine (TrueSkill)

Ranked 2.0's Skill is a **TrueSkill** model (Microsoft's Bayesian rating
system). Each player is represented by a normal distribution over "true skill":

- **μ (mu)** — the mean, i.e. the current best estimate of skill.
- **σ (sigma)** — the standard deviation, i.e. how *uncertain* that estimate is.

Ubisoft's stated conventions:

- New players start centered around **μ = 25** (described as "High Silver / Low
  Gold"), the middle of the population bell curve.
- The exposed matchmaking number is **MMR = 100 × μ** (so μ = 25 → 1000 MMR,
  μ = 50 → 5000 MMR, which is the Champion threshold).
- **σ starts high and shrinks** as the player plays more games. Lower σ = higher
  confidence = *smaller* future updates.

### 2.1 Standard TrueSkill parameters

These are the canonical TrueSkill defaults, scaled to Ubisoft's μ = 25 origin.
Use them as your starting constants:

```
MU_0    = 25.0            # initial mean skill
SIGMA_0 = 25.0 / 3        # ≈ 8.333, initial uncertainty
BETA    = 25.0 / 6        # ≈ 4.167, per-game performance variance (skill "noise")
TAU     = 25.0 / 300      # ≈ 0.083, additive dynamics factor (lets skill drift over time)
DRAW_P  = 0.0             # Siege ranked has no draws; set draw probability to 0
```

- **BETA** controls how much a single game's *performance* can differ from true
  skill. Higher β → outcomes are noisier → ratings move less per game.
- **TAU** is added to σ before each update so players who improve/decline in real
  life can be tracked (it prevents σ from collapsing to zero and freezing a
  rating forever).

### 2.2 How Skill updates after a match

Skill is updated on the **outcome only** — win or loss. Individual performance
(kills, KOST, objective plays) **does not** feed the Skill update in Ranked 2.0.
This is deliberate and is worth preserving if you want to match Siege's feel.

The update follows two rules that you get for free from TrueSkill:

1. **Surprise scales the update.** Beating a much stronger team, or losing to a
   much weaker one, moves your μ a lot. A result that matched expectations moves
   it a little.
2. **Confidence dampens the update.** The lower your σ, the smaller every update
   — a 500-game veteran's rating barely twitches; a fresh account's swings hard.

Ubisoft's own worked example (a Gold player at roughly **μ ≈ 29, σ ≈ 3**):

- Loses to a **Copper** team → μ drops to **≈ 28** (big hit; result was
  surprising).
- Loses to a **Diamond** team → μ drops to **≈ 28.9** (tiny hit; loss was
  expected).

For a full team-vs-team match you run the standard TrueSkill **team update**:
each team's skill is the sum of member μ's (and summed variances), you compute
the win probability from the difference, then distribute the adjustment back to
each player weighted by their own σ² share. Reference implementations you can
port directly:

- `trueskill` (Python), `Moserware.Skills` (C#), `ts-trueskill` (TypeScript),
  or the lighter-weight **OpenSkill** libraries if you want an open, patent-free
  equivalent with near-identical behavior.

### 2.3 Two-team update, in pseudocode

```
function update_skill(team_win, team_lose):          # each = list of {mu, sigma}
    # 1. inflate uncertainty slightly for dynamics
    for p in team_win + team_lose:
        p.sigma = sqrt(p.sigma^2 + TAU^2)

    # 2. team aggregates
    mu_w  = sum(p.mu for p in team_win)
    mu_l  = sum(p.mu for p in team_lose)
    var_w = sum(p.sigma^2 for p in team_win)
    var_l = sum(p.sigma^2 for p in team_lose)

    n = len(team_win) + len(team_lose)
    c = sqrt(var_w + var_l + n * BETA^2)             # total variance incl. perf noise

    t = (mu_w - mu_l) / c
    # v, w are the TrueSkill truncated-Gaussian correction terms:
    v = pdf(t) / cdf(t)
    w = v * (v + t)

    # 3. push each player toward/away from the result
    for p in team_win:                               # winners: nudged up
        p.mu    += (p.sigma^2 / c) * v
        p.sigma  = sqrt(p.sigma^2 * (1 - (p.sigma^2 / c^2) * w))
    for p in team_lose:                              # losers: nudged down
        p.mu    -= (p.sigma^2 / c) * v
        p.sigma  = sqrt(p.sigma^2 * (1 - (p.sigma^2 / c^2) * w))
```

`pdf`/`cdf` are the standard-normal density and cumulative functions. This is
the entire matchmaking-rating engine.

---

## 3. The visible RP layer

RP is what the player sees and what defines their rank badge. The rule Ubisoft
states verbatim:

> "The amount of RP that you win or lose after each match will be **proportional
> to the difference between your Skill and your Rank**."

So RP is a **convergence mechanism**: it drags your visible ladder position
toward where your hidden Skill says you belong.

### 3.1 The gap

Put Skill and Rank on the same scale so you can subtract them. Since
`MMR = 100 × μ` and RP is already on a 0–5000-ish scale, define:

```
skill_rp = 100 * mu          # where the system thinks you belong
gap      = skill_rp - rp     # + means underranked, − means overranked
```

- **gap > 0 (underranked):** you win more RP than you lose → you climb fast.
- **gap ≈ 0 (settled):** wins and losses roughly balance around your true rank.
- **gap < 0 (overranked):** you lose more than you gain → you sink back down.

This is why a smurf on a fresh account rockets up: their Skill climbs almost
instantly (high σ, surprising wins), so `gap` is large and positive, so each win
pays ~+80 RP while losses barely sting.

### 3.2 Documented anchor points

Ubisoft and community measurement give these reference magnitudes:

| Situation | RP on **win** | RP on **loss** |
|-----------|---------------|----------------|
| Large positive gap (climbing to your level) | ~ **+80** (cap) | ~ **−9** (floor) |
| Skill ≈ Rank (settled at true rank) | ~ **+40** | ~ **−30** |
| Negative gap (overranked / boosted) | ~ **+10 to +25** | ~ **−45 to −60** |

RP per match is roughly bounded to about **±80** at the extremes and hovers
**~±30–40** once you settle.

### 3.3 A reference RP formula (reconstruction)

Ubisoft has **not** published the exact RP equation, but the following
reproduces all three anchor rows above and is a clean thing to implement. Treat
the constants as tunable:

```
BASE      = 30      # neutral RP swing at gap = 0
GAP_SCALE = 1000    # RP-of-gap that maps to a full ±swing shift
SWING     = 40      # how far the gap can push a win up or a loss down
RP_MIN    = 9       # floor on |RP change| so a match is never worthless
RP_MAX    = 80      # cap on |RP change|

function rp_change(won, gap):
    # normalize gap into roughly [-1, +1]
    g = clamp(gap / GAP_SCALE, -1.5, 1.5)

    if won:
        change = BASE + SWING * g        # positive gap → bigger wins
    else:
        change = -BASE + SWING * g       # positive gap → smaller losses (g pulls toward 0)

    # enforce sign + bounds
    if won:
        return  clamp(change,  RP_MIN,  RP_MAX)
    else:
        return -clamp(-change, RP_MIN,  RP_MAX)
```

Sanity check against the anchors:

- `gap = +1000, won` → 30 + 40 = **+70** RP (≈ the +80 climb payout).
- `gap = +1000, lost` → −30 + 40 = **−0** → floored to **−9** RP (the tiny-loss case).
- `gap = 0, won / lost` → **+30 / −30** (settled).
- `gap = −1000, won / lost` → **−10 → +9** / **−70** → overranked bleed.

Tune `BASE`, `SWING`, and `GAP_SCALE` to hit whatever live numbers you're
targeting. The *shape* — linear in the gap, clamped at both ends, with a
non-zero floor — is the part that matters.

---

## 4. Rank & division structure

Ranked 2.0 has **8 tiers**. Every tier except Champion has **5 divisions**
labelled **V → IV → III → II → I** (V is the bottom of the tier). **Each
division is 100 RP wide.**

| # | Tier | Divisions | Approx. RP entry |
|---|------|-----------|------------------|
| 1 | Copper | V–I | 1,000 (season start) |
| 2 | Bronze | V–I | ~1,600 |
| 3 | Silver | V–I | ~2,100 |
| 4 | Gold | V–I | ~2,600 |
| 5 | Platinum | V–I | ~3,200 |
| 6 | **Emerald** | V–I | ~4,100 |
| 7 | Diamond | V–I | ~4,600 |
| 8 | **Champion** | *no divisions* | **5,000+** (μ = 50) |

Notes for implementers:

- **Emerald** was inserted between Platinum and Diamond specifically to flatten
  an over-steep late climb. It's a pure UI/threshold tier — no special rules.
- **Champion** is the top of the ladder: reached at ~5,000 RP (equivalently
  μ ≈ 50). It has no sub-divisions; instead Champions are ordered on a
  **numbered leaderboard**, and the top players show a rank number
  (the "Top 500"-style presentation).
- Because a division is exactly 100 RP and a typical win is ~+40 RP, a settled
  player crosses roughly a division every 2–3 wins — an intentional pacing
  target you can use to calibrate `BASE`.

Model rank as a single integer RP value; derive tier/division/badge purely by
bucketing RP against the threshold table. Don't store tier separately — it's a
view of RP.

---

## 5. Match & season lifecycle

### 5.1 Season reset (soft reset)

At the start of each season:

- **RP is reset**: every player drops to **Copper V (~1,000 RP)**.
- **Skill (μ, σ) persists** across the season boundary, though Ubisoft nudges σ
  up a little so the system re-confirms where strong players belong. This is
  what makes the early-season climb fast for good players — high `gap`, high σ.
- **No placement matches.** Ranked 2.0 removed the old 10-game calibration; you
  rank up from Copper V on match one, and the Skill↔Rank gap does the
  calibration work implicitly.

### 5.2 Demotion Shield

RP is not allowed to silently drop you a tier mid-match:

- If a loss would take you **below 0 RP within your current division/tier
  boundary**, the shield instead **clamps you at 0 RP** *for that match*,
  provided you entered the match above 0 RP.
- If you're **already at 0 RP** and lose again, the demotion goes through
  normally and you drop.

```
function apply_rp_loss(rp_before, delta):     # delta is negative
    new_rp = rp_before + delta
    if crosses_demotion_boundary(rp_before, new_rp) and rp_before > boundary:
        return boundary          # shielded: sit at the floor this match
    return new_rp                # already at floor → real demotion allowed
```

### 5.3 Matchmaking

Matchmaking uses **Skill only**. Form two teams that **equalize predicted win
probability** (target ≈ 50/50) by minimizing the difference of summed team μ,
subject to latency/queue-time constraints. TrueSkill gives you the win-prob
directly from the team skill difference, so your matcher's objective is simply
"make `P(win) ≈ 0.5`."

### 5.4 Squads / stacks

- Ranked 2.0 **removed the hard Squad-MMR restriction** (the old rule that
  capped how far apart friends' MMRs could be — historically a **1,000 MMR**
  gap). Players can now queue with friends of any rank.
- Backend exploit-prevention replaced the hard cap, and full **5-stacks** can
  receive a **small RP-gain reduction** to account for the coordination edge.
  Implement this as a multiplier on positive RP for fully-premade lobbies if you
  want parity.

### 5.5 Champion upkeep

Champions must keep playing to hold the rank — Ubisoft requires a minimum number
of ranked matches per season (community-reported ~**100 matches**) to stay on
the Champion leaderboard. Model this as a decay/eligibility check, not a rating
change.

---

## 6. Putting it together — one match, end to end

```
function resolve_ranked_match(match):
    winners, losers = match.winning_team, match.losing_team

    # 1. HIDDEN: update TrueSkill from outcome only
    update_skill(winners, losers)              # mutates each player's mu, sigma

    # 2. VISIBLE: update RP from the Skill↔Rank gap, per player
    for p in winners:
        gap = 100 * p.mu - p.rp
        p.rp += rp_change(won=True, gap=gap)
        p.rp  = min(p.rp, RP_HARD_CAP)         # optional ceiling handling

    for p in losers:
        gap   = 100 * p.mu - p.rp
        delta = rp_change(won=False, gap=gap)
        p.rp  = apply_rp_loss(p.rp, delta)     # demotion shield

    # 3. DERIVE badge purely from RP
    for p in winners + losers:
        p.tier, p.division = bucket_rp_to_rank(p.rp)
```

That's the whole system: a TrueSkill core for matchmaking, an RP convergence
layer for the visible ladder, and a threshold table for the badges.

---

## 7. What's official vs. reconstructed

Being explicit so you know where you can trust numbers and where to tune:

**Confirmed by Ubisoft:**
- Two-layer split: hidden Skill vs. visible RP.
- Skill is **TrueSkill** with μ and σ; **MMR = 100 × μ**; μ centered at 25;
  Champion at ~5,000 MMR (μ ≈ 50).
- Skill updates on **outcome only**; surprise increases and confidence (low σ)
  decreases update size.
- RP change is **proportional to (Skill − Rank)**.
- 8 tiers, 5 divisions each (except Champion), **100 RP per division**, Emerald
  inserted between Plat and Diamond.
- Season resets RP to Copper V; **no placement matches**; Demotion Shield at
  0 RP; squad MMR restriction removed.

**Reconstructed / approximate (tune these):**
- Exact TrueSkill constants (β, τ) — the values given are canonical defaults,
  not Ubisoft's private tuning.
- The precise **RP formula** in §3.3 — Ubisoft publishes only the anchor
  magnitudes (~+80/−9 climbing, ~+40/−30 settled), not the equation.
- Exact per-tier RP entry thresholds, the 5-stack RP multiplier, and the
  Champion match-count upkeep — community-measured, not officially specified.

---

## 8. Implementation checklist

- [ ] TrueSkill (or OpenSkill) rating store: `{mu, sigma}` per player, per queue.
- [ ] Team update on match result; **do not** feed individual stats into Skill.
- [ ] Separate persistent `rp` integer per player, per season.
- [ ] `gap = 100*mu - rp` → clamped, floored RP change with a non-zero minimum.
- [ ] Threshold table → derive tier/division/badge from RP alone.
- [ ] Season rollover: reset RP, keep μ, bump σ slightly, no placements.
- [ ] Demotion Shield at division/tier floors.
- [ ] Matchmaker objective: minimize team-Skill difference (P(win) ≈ 0.5).
- [ ] Champion: no divisions, numbered leaderboard, match-count upkeep.
- [ ] Optional: 5-stack RP-gain reduction, abandon/inactivity penalties.

---

## Sources

- [Ubisoft — Matchmaking Rating (official)](https://www.ubisoft.com/en-us/game/rainbow-six/siege/news-updates/4hShcX2HZTG2ttIi3IIN9Y/matchmaking-rating)
- [Ubisoft — Y7S4 Ranked 2.0 Update (official)](https://www.ubisoft.com/en-us/game/rainbow-six/siege/news-updates/1iJmqRLqYaCkhFJlhOEGYa/y7s4-ranked-20-update)
- [GameRiv — Ranked 2.0: How does it work?](https://gameriv.com/rainbow-six-siege-ranked-2-0-how-does-it-work/)
- [Rainbow Six Wiki (Fandom) — Ranked](https://rainbowsix.fandom.com/wiki/Ranked)
- [GameTree — R6 Ranks explained](https://gametree.me/blog/r6-ranks/)
- [WeCoach — R6 Ranks explained](https://wecoach.gg/blog/article/rainbow-six-siege-ranks-explained)
- TrueSkill reference: Herbrich, Minka & Graepel, *TrueSkill™: A Bayesian Skill Rating System* (Microsoft Research); libraries `trueskill` (Python), `ts-trueskill` (TS), `openskill`.
