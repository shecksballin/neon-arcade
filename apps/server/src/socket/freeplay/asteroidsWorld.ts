/**
 * ASTEROIDS WORLD — server-authoritative ship combat
 * ==================================================
 * ONE engine, three modes (free_play permanent world, slayer + lms
 * match-scoped lobbies). The mode lives entirely in World; this file is
 * pure simulation.
 *
 * PRACTICE PARITY (contract: "match practice movement constants exactly")
 * Every constant below is lifted verbatim from the practice game
 * `apps/web/src/components/Asteroids/AsteroidsCore.tsx`:
 *   world           8000 × 8000, coordinates [0, 8000]
 *   ship radius     15                       (was 24 here)
 *   thrust          acceleration 0.2 / frame, friction 0.98 / frame
 *                   → terminal 9.8 u/frame = 588 u/s  (was a flat 260 u/s)
 *   turn            angular accel 0.008 / frame², angular friction 0.88,
 *                   |ω| ≤ 0.16 rad/frame → terminal 3.52 rad/s
 *   auto-realign    when NOT turning, ω += angleDiff × 0.003 toward the
 *                   nearest of north/south (practice's "jet realign")
 *   guns            800 RPM (75 ms), magazine 100, reload 1500 ms
 *   bullets         20 u/frame = 1200 u/s + the ship's forward velocity,
 *                   radius 3, 20 damage (50 from behind — practice backstab)
 *   hull            100 hp; touching a rock is instant death
 *   rocks           30 rocks, radius 20–60, drift ≤ 1.5 u/frame (90 u/s)
 * The practice loop integrates per animation frame, so ships, bullets and
 * rocks move here in fixed 1/60 s SUB-STEPS (3 per 20 Hz tick).
 *
 * THE SHRINKING SAFE ZONE (contract: "Zone simulation in match worlds")
 * A match world runs the practice difficulty code the lobby derived from
 * (sector, mode) — 10/11 ECLIPSE, 12/13 BLITZ — and with it the SAME zone
 * state machine practice runs (`AsteroidsCore.tsx` `updateZone`): a ring
 * that interpolates onto a randomly-placed next safe zone over a timed
 * shrink phase, holds through a stabilization phase, then repeats against a
 * fresh target. Outside the ring is INSTANT death for every 10+ code, which
 * is every online sector. The permanent free-play world runs difficulty 1 —
 * no zone, nothing here changes for it. The zone is simulated ONLY here and
 * shipped in the snapshot (`state.zone`); no client runs a second copy.
 *
 * DELIBERATE DEVIATIONS (documented, not accidental):
 * - Hull regen (5 hp/s after 4 s out of combat) stands in for practice's
 *   health-pickup asteroids, which this world does not spawn.
 * - Reserve ammo is infinite (a reload always refills the magazine); the
 *   practice reserve is refilled by ammo asteroids that do not exist here.
 * - Bullets carry a 4 s TTL so a long-lived process can never accumulate
 *   an unbounded number of them; practice bullets expire at the world edge.
 */

import type { Socket } from 'socket.io'
import { SpatialGrid } from './grid'
import { World, type FreeplayWorld, type WorldOptions } from './world'
import {
  PRACTICE_FPS,
  SUBSTEPS_PER_TICK,
  SUBSTEP_DT,
  asteroidsInputSchema,
  type AsteroidsInput,
  type BaseSession,
  type WorldBounds,
} from './types'

// ─────────────────────────────────────────────────
// Tuning constants — practice-mode values (see header)
// ─────────────────────────────────────────────────

const WORLD_SIZE = 8000
const BOUNDS: WorldBounds = { minX: 0, minY: 0, maxX: WORLD_SIZE, maxY: WORLD_SIZE }

/** Grid cell size — ≈2× the largest asteroid diameter. */
const GRID_CELL = 600

/**
 * Interest radius. The practice camera zooms out to 0.5 at 10+ kills, which
 * shows ~2200 units to a screen corner on 1920×1080; 2400 covers it.
 */
const VIEW_RADIUS = 2400

// ── ship (practice `playerRef` defaults) ─────────
const SHIP_RADIUS = 15
const MAX_HP = 100
/** Practice acceleration is 0.2 velocity-units per FRAME; our velocities
 *  are per SECOND, so one frame adds 0.2 × 60. */
const THRUST_PER_FRAME = 0.2 * 60
const VEL_FRICTION_PER_FRAME = 0.98
/** Angular accel 0.008 rad/frame² → 0.48 rad/s added per frame. */
const TURN_ACCEL_PER_FRAME = 0.008 * 60
const ANGULAR_FRICTION_PER_FRAME = 0.88
/** Practice clamps |angularVelocity| to 0.16 rad/frame. */
const MAX_TURN_RATE = 0.16 * 60
/** Practice's gentle pull back to north/south while not turning. */
const REALIGN_PER_FRAME = 0.003 * 60

/** Not in practice — see the header's deviation note. */
const REGEN_PER_S = 5
const REGEN_DELAY_MS = 4000

// ── guns (practice) ──────────────────────────────
const FIRE_INTERVAL_MS = 60_000 / 800 // = 75 ms between rounds
const MAG_SIZE = 100
const RELOAD_MS = 1500

// ── bullets (practice) ───────────────────────────
const BULLET_SPEED = 20 * 60 // 20 u/frame → 1200 u/s
const BULLET_RADIUS = 3
const BULLET_DAMAGE = 20
/** Practice: a hit from behind (bullet travelling roughly the same way the
 *  target faces, < 0.6 rad apart) does 50. */
const BULLET_BACKSTAB_DAMAGE = 50
const BACKSTAB_ANGLE = 0.6
const BULLET_TTL_MS = 4000
/** Hard cap on in-flight bullets (long-lived-process hygiene). */
const MAX_BULLETS = 4000

// ── asteroid field (practice initial spawn) ──────
const ASTEROID_COUNT = 30
const ASTEROID_MIN_R = 20
const ASTEROID_MAX_R = 60
/** Practice: vx = (random − 0.5) × 3 per frame → ±1.5 u/frame = ±90 u/s. */
const ASTEROID_MAX_DRIFT = 1.5 * 60

// ── scoring (practice) ───────────────────────────
const KILL_SCORE = 100

// ── spawn safety ─────────────────────────────────
const SPAWN_ATTEMPTS = 15
const SAFE_SPAWN_SHIP_DIST = 600 // no other ship this close
const SAFE_SPAWN_ROCK_PAD = 300 // clearance beyond an asteroid's radius

/**
 * ZONE SPAWN — how far from the ring centre a ship may be dropped, as a
 * fraction of the CURRENT ring radius.
 *
 * Practice spawns the ship at the exact middle of the map
 * (`AsteroidsCore.tsx`: `x: WORLD_SIZE / 2, y: WORLD_SIZE / 2`), which is also
 * the centre of the opening ring. Scattering online players over the whole map
 * instead leaves the ones near a corner outside the ring within seconds. Zone
 * worlds therefore spawn inside the ring; free play keeps the original
 * whole-map scatter untouched.
 */
const ZONE_SPAWN_RADIUS_FRACTION = 0.4

// ─────────────────────────────────────────────────
// Safe zone — verbatim from practice `AsteroidsCore.tsx` (`updateZone`)
// ─────────────────────────────────────────────────

/** Practice: the first ring is `radius: WORLD_SIZE` centred on the middle of
 *  the map — deliberately bigger than the map itself, so nobody starts
 *  outside it. */
const ZONE_START_RADIUS = WORLD_SIZE
const ZONE_START_X = WORLD_SIZE / 2
const ZONE_START_Y = WORLD_SIZE / 2

/** Practice `generateNextZone`: the next ring is 30% of the current radius
 *  in Blitz, 50% otherwise. */
const ZONE_SHRINK_FACTOR_BLITZ = 0.3
const ZONE_SHRINK_FACTOR_DEFAULT = 0.5

/** Shrink-phase length: Blitz gets 20 s for phase 1 and 10 s after that;
 *  Eclipse gets a flat 30 s. */
const ZONE_PHASE_BLITZ_FIRST = 20
const ZONE_PHASE_BLITZ_LATER = 10
const ZONE_PHASE_DEFAULT = 30

/** Stabilization (non-shrinking) window: 15 s in Blitz, 30 s otherwise. */
const ZONE_STABLE_BLITZ = 15
const ZONE_STABLE_DEFAULT = 30

/** Practice Blitz: the last 3 s of a stable phase render a countdown. */
const ZONE_BLITZ_COUNTDOWN_S = 3

/**
 * Practice's TARGET-LESS fallback shrink (`zone.radius -= speed * dt`, in
 * per-frame units): 2.5 for the LMS codes 11|13, 1.5 otherwise, floored at
 * 100. A 10+ world always has a target ring, so this branch is unreachable
 * online — it is ported anyway so the fallback can never silently differ
 * from practice.
 */
const ZONE_FALLBACK_SHRINK_FAST = 2.5
const ZONE_FALLBACK_SHRINK_DEFAULT = 1.5
const ZONE_FALLBACK_MIN_RADIUS = 100

/** A zone circle. Field names match the practice `safeZone` / `nextSafeZone`
 *  objects so the client can drop them straight in. */
interface ZoneCircle {
  x: number
  y: number
  radius: number
}

// ─────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────

interface AsteroidsSession extends BaseSession<AsteroidsInput> {
  angle: number // heading in radians — server-owned, turned by input only
  /** Angular velocity in rad/SECOND (practice stores rad/frame). */
  angularVelocity: number
  hp: number
  ammo: number
  /** Non-null while reloading: the Date.now() when the mag refills. */
  reloadingUntil: number | null
  /** Fire-rate pacing anchor. */
  lastShotAt: number
  lastDamagedAt: number
}

interface Bullet {
  id: number
  /** Kill attribution — SERVER-ONLY (wallets never hit the wire). */
  ownerWallet: string
  /** The shooter's opaque session id — safe for clients to render. */
  ownerId: string
  x: number
  y: number
  vx: number
  vy: number
  diesAt: number
}

interface Asteroid {
  id: number
  x: number
  y: number
  r: number
  vx: number
  vy: number
}

// ─────────────────────────────────────────────────
// World
// ─────────────────────────────────────────────────

export class AsteroidsWorld extends World<AsteroidsInput, AsteroidsSession> {
  // Rebuilt every sub-step before collision resolution.
  private readonly shipGrid = new SpatialGrid<AsteroidsSession>(GRID_CELL)
  private readonly asteroidGrid = new SpatialGrid<Asteroid>(GRID_CELL)
  private readonly bulletGrid = new SpatialGrid<Bullet>(GRID_CELL)

  /** The drifting rock field. */
  private readonly asteroids: Asteroid[] = []

  /** id → bullet, capped at MAX_BULLETS. */
  private readonly bullets = new Map<number, Bullet>()
  private nextBulletId = 1

  // Reused query scratch arrays (no per-query allocation).
  private readonly shipScratch: AsteroidsSession[] = []
  private readonly rockScratch: Asteroid[] = []
  private readonly bulletScratch: Bullet[] = []

  // ── safe zone (practice `zoneRef.current`, field for field) ──
  // Which zone (if any) this world runs comes from the BASE class: it owns
  // `difficulty` (1 = free play, 10/11 Eclipse, 12/13 Blitz) plus the
  // `zoneEnabled` / `isBlitz` / `isFastShrink` predicates practice keys off.
  /** The live ring — practice `zone.x` / `zone.y` / `zone.radius`. */
  private zoneX = ZONE_START_X
  private zoneY = ZONE_START_Y
  private zoneRadius = ZONE_START_RADIUS
  /** The ring reached by the last shrink (practice `zone.safeZone`). */
  private safeZone: ZoneCircle = {
    x: ZONE_START_X,
    y: ZONE_START_Y,
    radius: ZONE_START_RADIUS,
  }
  /** The ring being shrunk toward (practice `zone.nextSafeZone`). */
  private nextSafeZone: ZoneCircle | null = null
  private isZoneShrinking = false
  private zonePhase = 1
  /** Seconds left in the current phase (practice `zone.phaseTimer`). */
  private zonePhaseTimer = ZONE_PHASE_DEFAULT
  /** Blitz only: seconds until the next shrink during the last 3 s of a
   *  stable phase (practice `zone.countdownTimer`); null otherwise. */
  private countdownTimer: number | null = null

  constructor(options: WorldOptions) {
    super('asteroids', BOUNDS, VIEW_RADIUS, options)
    // Seed the drift field once (practice: 30 rocks scattered world-wide).
    for (let i = 0; i < ASTEROID_COUNT; i++) {
      const r = ASTEROID_MIN_R + Math.random() * (ASTEROID_MAX_R - ASTEROID_MIN_R)
      this.asteroids.push({
        id: i + 1,
        x: r + Math.random() * (WORLD_SIZE - 2 * r),
        y: r + Math.random() * (WORLD_SIZE - 2 * r),
        r,
        vx: (Math.random() - 0.5) * 2 * ASTEROID_MAX_DRIFT,
        vy: (Math.random() - 0.5) * 2 * ASTEROID_MAX_DRIFT,
      })
    }

    // Zone setup — practice's `startGame` initial `zoneRef.current`.
    if (this.zoneEnabled) {
      this.nextSafeZone = this.generateNextZone(this.safeZone)
      // Practice starts phase 1 already shrinking ("as in Cells").
      this.isZoneShrinking = true
      this.zonePhaseTimer = this.shrinkPhaseDuration()
    }
  }

  /** How long the CURRENT shrink phase lasts: Blitz takes 20 s for phase 1
   *  and 10 s for every phase after it; Eclipse takes a flat 30 s. */
  private shrinkPhaseDuration(): number {
    if (!this.isBlitz) return ZONE_PHASE_DEFAULT
    return this.zonePhase > 1 ? ZONE_PHASE_BLITZ_LATER : ZONE_PHASE_BLITZ_FIRST
  }

  /**
   * Practice `generateNextZone`: a ring 30% (Blitz) / 50% of the current
   * radius, at a random centre that keeps it inside the current ring.
   * (Practice does NOT clamp it to the world box — a late ring can hang off
   * the edge of the map, and that is deliberately preserved here.)
   */
  private generateNextZone(current: ZoneCircle): ZoneCircle {
    const shrinkFactor = this.isBlitz ? ZONE_SHRINK_FACTOR_BLITZ : ZONE_SHRINK_FACTOR_DEFAULT
    const nextRadius = current.radius * shrinkFactor
    const maxOffset = current.radius - nextRadius
    const angle = Math.random() * Math.PI * 2
    const distance = Math.random() * maxOffset
    return {
      x: current.x + Math.cos(angle) * distance,
      y: current.y + Math.sin(angle) * distance,
      radius: nextRadius,
    }
  }

  // ── game hooks ─────────────────────────────────

  protected parseInput(raw: unknown): AsteroidsInput | null {
    const parsed = asteroidsInputSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  protected newSession(
    id: string,
    wallet: string,
    name: string,
    socket: Socket
  ): AsteroidsSession {
    return {
      ...this.baseFields(id, wallet, name, socket),
      angle: -Math.PI / 2, // practice spawns pointing north
      angularVelocity: 0,
      hp: MAX_HP,
      ammo: MAG_SIZE,
      reloadingUntil: null,
      lastShotAt: 0,
      lastDamagedAt: 0,
    }
  }

  /** Fresh life: full hull, full mag, at rest, safe random spot. */
  protected spawn(session: AsteroidsSession): void {
    session.r = SHIP_RADIUS
    session.hp = MAX_HP
    session.ammo = MAG_SIZE
    session.reloadingUntil = null
    session.lastShotAt = 0
    session.lastDamagedAt = 0
    session.vx = 0
    session.vy = 0
    session.angularVelocity = 0
    session.angle = Math.random() * Math.PI * 2
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const spot = this.spawnPoint()
      session.x = spot.x
      session.y = spot.y
      if (this.isSpawnSafe(session)) break
      // last attempt keeps the final candidate — risky beats infinite
    }
  }

  /**
   * A candidate spawn spot. Free play (no zone) keeps the whole-map scatter;
   * a zone world spawns INSIDE the live ring near its centre, mirroring
   * practice's dead-centre start, and clamps back into the map because the
   * ring may hang off the edge.
   */
  private spawnPoint(): { x: number; y: number } {
    if (!this.zoneEnabled) {
      return {
        x: 200 + Math.random() * (WORLD_SIZE - 400),
        y: 200 + Math.random() * (WORLD_SIZE - 400),
      }
    }
    const angle = Math.random() * Math.PI * 2
    const dist = Math.sqrt(Math.random()) * this.zoneRadius * ZONE_SPAWN_RADIUS_FRACTION
    const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
    return {
      x: clamp(this.zoneX + Math.cos(angle) * dist, 200, WORLD_SIZE - 200),
      y: clamp(this.zoneY + Math.sin(angle) * dist, 200, WORLD_SIZE - 200),
    }
  }

  /** Clear of every asteroid (+pad) and of other live ships. */
  private isSpawnSafe(session: AsteroidsSession): boolean {
    for (const rock of this.asteroids) {
      const dx = rock.x - session.x
      const dy = rock.y - session.y
      const minDist = rock.r + SAFE_SPAWN_ROCK_PAD
      if (dx * dx + dy * dy < minDist * minDist) return false
    }
    for (const other of this.sessions.values()) {
      if (other === session || !other.alive) continue
      const dx = other.x - session.x
      const dy = other.y - session.y
      if (dx * dx + dy * dy < SAFE_SPAWN_SHIP_DIST * SAFE_SPAWN_SHIP_DIST) return false
    }
    return true
  }

  /** A leaver's bullets vanish with them — kill attribution can never point
   *  at a session that no longer exists (also a leak guard). */
  protected override onDespawn(session: AsteroidsSession): void {
    for (const [id, b] of this.bullets) {
      if (b.ownerWallet === session.wallet) this.bullets.delete(id)
    }
  }

  // ── simulation ─────────────────────────────────

  protected step(now: number, dt: number): void {
    // Guns run once per tick (75 ms rounds vs a 50 ms tick), everything
    // else is integrated at the practice frame rate.
    this.stepGuns(now)
    for (let i = 0; i < SUBSTEPS_PER_TICK; i++) this.simulateFrame(now, SUBSTEP_DT)

    // The ring advances against final positions, then catches whoever is
    // outside it — practice runs `updateZone` once per frame for the same
    // reason (it is pure dt maths, so the tick rate does not change it).
    this.updateZone(dt)

    // Bullet grid for the interest-managed broadcast (buildState).
    this.rebuildBulletGrid()
  }

  /**
   * ONE zone step — practice `AsteroidsCore.tsx` `updateZone`, in its order:
   * age the phase timer, move/shrink the ring, flip the phase machine,
   * refresh the Blitz countdown, then kill everyone outside the ring.
   *
   * Practice measures dt in FRAMES (it divides by 60 for seconds); this
   * takes seconds and converts, so the per-frame constants transfer without
   * being re-tuned. Only called while the world is RUNNING — the base class
   * does not step a world during the lobby countdown, so the ring starts
   * moving exactly when the match does.
   */
  private updateZone(dt: number): void {
    if (!this.zoneEnabled) return
    const frames = dt * PRACTICE_FPS

    this.zonePhaseTimer -= dt

    // ── move / shrink (practice does this BEFORE the phase flip) ──
    if (this.isZoneShrinking) {
      if (this.nextSafeZone) {
        // Converge on the target ring exactly as the phase timer expires.
        const stepFraction = Math.min(1, dt / Math.max(0.01, this.zonePhaseTimer))
        this.zoneX += (this.nextSafeZone.x - this.zoneX) * stepFraction
        this.zoneY += (this.nextSafeZone.y - this.zoneY) * stepFraction
        this.zoneRadius += (this.nextSafeZone.radius - this.zoneRadius) * stepFraction
      } else {
        // Target-less fallback (unreachable at 10+ — see the constants).
        const shrinkSpeed =
          (this.isFastShrink ? ZONE_FALLBACK_SHRINK_FAST : ZONE_FALLBACK_SHRINK_DEFAULT) *
          frames
        this.zoneRadius = Math.max(ZONE_FALLBACK_MIN_RADIUS, this.zoneRadius - shrinkSpeed)
      }
    }

    // ── phase machine ──
    if (this.zonePhaseTimer <= 0) {
      if (this.isZoneShrinking) {
        // Shrink done → stabilize on the ring we just reached and publish
        // the next target so players can see where to run.
        this.isZoneShrinking = false
        this.countdownTimer = null
        this.safeZone = this.nextSafeZone
          ? { ...this.nextSafeZone }
          : { x: this.zoneX, y: this.zoneY, radius: this.zoneRadius }
        this.nextSafeZone = this.generateNextZone(this.safeZone)
        this.zonePhaseTimer = this.isBlitz ? ZONE_STABLE_BLITZ : ZONE_STABLE_DEFAULT
      } else {
        // Stable window over → next shrink.
        this.isZoneShrinking = true
        this.zonePhase += 1
        this.zonePhaseTimer = this.shrinkPhaseDuration()
      }
    }

    // ── Blitz: 3 s countdown before a shrink starts ──
    this.countdownTimer =
      !this.isZoneShrinking && this.isBlitz && this.zonePhaseTimer <= ZONE_BLITZ_COUNTDOWN_S
        ? this.zonePhaseTimer
        : null

    // ── outside the ring = instant death for every 10+ code ──
    // (Practice's graded out-of-zone damage belongs to difficulties 4–9,
    // which no online world ever runs — every online sector is 10+.)
    // Snapshot the sessions: an environment kill can mutate the map.
    for (const s of [...this.sessions.values()]) {
      if (!s.alive) continue
      const dx = s.x - this.zoneX
      const dy = s.y - this.zoneY
      if (dx * dx + dy * dy > this.zoneRadius * this.zoneRadius) {
        s.hp = 0
        this.resolveEnvironmentKill(s, 'zone')
      }
    }
  }

  /** Every query grid at current positions, no simulation — used by the
   *  lobby countdown broadcast. */
  protected refreshGrids(): void {
    this.shipGrid.clear()
    this.asteroidGrid.clear()
    for (const s of this.sessions.values()) {
      if (s.alive) this.shipGrid.insert(s, s.x, s.y, SHIP_RADIUS)
    }
    for (const rock of this.asteroids) {
      this.asteroidGrid.insert(rock, rock.x, rock.y, rock.r)
    }
    this.rebuildBulletGrid()
  }

  private rebuildBulletGrid(): void {
    this.bulletGrid.clear()
    for (const b of this.bullets.values()) {
      this.bulletGrid.insert(b, b.x, b.y, BULLET_RADIUS)
    }
  }

  /** Reload state machine + rate-limited firing (practice: 800 RPM). */
  private stepGuns(now: number): void {
    for (const s of this.sessions.values()) {
      if (!s.alive) continue
      const input = s.input
      if (s.reloadingUntil !== null) {
        if (now >= s.reloadingUntil) {
          s.ammo = MAG_SIZE // reserve is infinite — see the header note
          s.reloadingUntil = null
        }
      } else if (input?.reload && s.ammo < MAG_SIZE) {
        s.reloadingUntil = now + RELOAD_MS // manual reload via flag
      } else if (input?.shoot && s.ammo > 0) {
        // 800 RPM = one round per 75 ms, which doesn't divide the 50 ms
        // tick — so pace with an accumulator: fire every round that came due
        // since lastShotAt. The anchor is first clamped so a released
        // trigger can never BANK shots for a later burst.
        if (now - s.lastShotAt > FIRE_INTERVAL_MS * 2) {
          s.lastShotAt = now - FIRE_INTERVAL_MS
        }
        while (s.ammo > 0 && now - s.lastShotAt >= FIRE_INTERVAL_MS) {
          s.lastShotAt += FIRE_INTERVAL_MS
          this.fireBullet(s, now)
        }
        if (s.ammo === 0) s.reloadingUntil = now + RELOAD_MS // auto-reload
      }
    }
  }

  /**
   * ONE practice frame (1/60 s): rocks drift, ships turn/thrust/regen,
   * bullets fly and collide, ships hit rocks. Sub-stepping keeps the fast
   * bullets (20 units per frame vs an 18-unit hit radius) from tunnelling
   * any more than they do in practice.
   */
  private simulateFrame(now: number, dt: number): void {
    // 1) Asteroids drift and bounce off the walls (practice: vx *= -1).
    for (const rock of this.asteroids) {
      rock.x += rock.vx * dt
      rock.y += rock.vy * dt
      if (rock.x < rock.r) {
        rock.x = rock.r
        rock.vx = Math.abs(rock.vx)
      } else if (rock.x > WORLD_SIZE - rock.r) {
        rock.x = WORLD_SIZE - rock.r
        rock.vx = -Math.abs(rock.vx)
      }
      if (rock.y < rock.r) {
        rock.y = rock.r
        rock.vy = Math.abs(rock.vy)
      } else if (rock.y > WORLD_SIZE - rock.r) {
        rock.y = WORLD_SIZE - rock.r
        rock.vy = -Math.abs(rock.vy)
      }
    }

    // 2) Ships: turn, auto-realign, auto-drive, wall barrier, regen.
    for (const s of this.sessions.values()) {
      if (!s.alive) continue
      const turn = s.input?.turn ?? 0

      if (turn !== 0) {
        // Cash-out hold halves the turn authority (free play only).
        s.angularVelocity += turn * TURN_ACCEL_PER_FRAME * this.moveScale(s)
      } else {
        // Practice realigns the jet toward the nearest of north/south when
        // the player is not actively turning.
        s.angularVelocity += this.realignDelta(s.angle)
      }
      s.angularVelocity = Math.max(-MAX_TURN_RATE, Math.min(MAX_TURN_RATE, s.angularVelocity))
      s.angle += s.angularVelocity * dt
      s.angularVelocity *= ANGULAR_FRICTION_PER_FRAME

      // Auto-drive: constant forward thrust, then friction (practice).
      s.vx += Math.cos(s.angle) * THRUST_PER_FRAME
      s.vy += Math.sin(s.angle) * THRUST_PER_FRAME
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.vx *= VEL_FRICTION_PER_FRAME
      s.vy *= VEL_FRICTION_PER_FRAME

      // Practice uses a barrier (clamp + half-speed rebound), NOT a bounce
      // of the heading — the ship noses into the wall until you turn.
      if (s.x < SHIP_RADIUS) {
        s.x = SHIP_RADIUS
        s.vx *= -0.5
      } else if (s.x > WORLD_SIZE - SHIP_RADIUS) {
        s.x = WORLD_SIZE - SHIP_RADIUS
        s.vx *= -0.5
      }
      if (s.y < SHIP_RADIUS) {
        s.y = SHIP_RADIUS
        s.vy *= -0.5
      } else if (s.y > WORLD_SIZE - SHIP_RADIUS) {
        s.y = WORLD_SIZE - SHIP_RADIUS
        s.vy *= -0.5
      }

      // Out-of-combat hull regen (stand-in for practice's health rocks).
      if (s.hp < MAX_HP && now - s.lastDamagedAt >= REGEN_DELAY_MS) {
        s.hp = Math.min(MAX_HP, s.hp + REGEN_PER_S * dt)
      }
    }

    // 3) Rebuild ship + asteroid grids at post-move positions. (The bullet
    // grid is only needed for the broadcast, so it is rebuilt once a tick.)
    this.shipGrid.clear()
    this.asteroidGrid.clear()
    for (const s of this.sessions.values()) {
      if (s.alive) this.shipGrid.insert(s, s.x, s.y, SHIP_RADIUS)
    }
    for (const rock of this.asteroids) {
      this.asteroidGrid.insert(rock, rock.x, rock.y, rock.r)
    }

    // 4) Bullets: fly, expire, get eaten by rocks, hit ships.
    for (const [id, b] of this.bullets) {
      b.x += b.vx * dt
      b.y += b.vy * dt
      // Expired, or flew off the world (practice bullets don't bounce).
      if (now >= b.diesAt || b.x < 0 || b.x > WORLD_SIZE || b.y < 0 || b.y > WORLD_SIZE) {
        this.bullets.delete(id)
        continue
      }
      // Asteroids absorb bullets (v1 — server rocks don't shrink or split).
      this.rockScratch.length = 0
      const rocks = this.asteroidGrid.query(b.x, b.y, BULLET_RADIUS, this.rockScratch)
      let absorbed = false
      for (const rock of rocks) {
        const dx = rock.x - b.x
        const dy = rock.y - b.y
        const hitDist = rock.r + BULLET_RADIUS
        if (dx * dx + dy * dy < hitDist * hitDist) {
          absorbed = true
          break
        }
      }
      if (absorbed) {
        this.bullets.delete(id)
        continue
      }
      // Ship hits: 20 damage, 50 from behind (practice backstab).
      this.shipScratch.length = 0
      const ships = this.shipGrid.query(b.x, b.y, BULLET_RADIUS, this.shipScratch)
      for (const target of ships) {
        if (!target.alive || target.wallet === b.ownerWallet) continue
        const dx = target.x - b.x
        const dy = target.y - b.y
        const hitDist = SHIP_RADIUS + BULLET_RADIUS
        if (dx * dx + dy * dy >= hitDist * hitDist) continue
        this.bullets.delete(id)
        target.hp -= this.bulletDamage(b, target)
        target.lastDamagedAt = now
        if (target.hp <= 0) {
          // The owner session always exists while its bullets do (despawn
          // removes them — see onDespawn), but stay defensive.
          const killer = this.sessions.get(b.ownerWallet)
          if (killer) {
            killer.score += KILL_SCORE
            this.resolveKill(killer, target)
          }
        }
        break // one bullet, one hit
      }
    }

    // 5) Ship ↔ asteroid: instant death (practice). Checked AFTER bullets so
    // a same-tick bullet kill wins attribution.
    for (const s of this.sessions.values()) {
      if (!s.alive) continue
      this.rockScratch.length = 0
      const rocks = this.asteroidGrid.query(s.x, s.y, SHIP_RADIUS, this.rockScratch)
      for (const rock of rocks) {
        const dx = rock.x - s.x
        const dy = rock.y - s.y
        const hitDist = rock.r + SHIP_RADIUS
        if (dx * dx + dy * dy < hitDist * hitDist) {
          this.resolveEnvironmentKill(s, 'asteroid')
          break
        }
      }
    }
  }

  /** Practice's "realign the jet" pull toward the nearest of north/south. */
  private realignDelta(angle: number): number {
    let norm = angle % (Math.PI * 2)
    if (norm > Math.PI) norm -= Math.PI * 2
    if (norm < -Math.PI) norm += Math.PI * 2
    const north = -Math.PI / 2
    const south = Math.PI / 2
    const target = Math.abs(norm - north) < Math.abs(norm - south) ? north : south
    let diff = target - norm
    if (diff > Math.PI) diff -= Math.PI * 2
    if (diff < -Math.PI) diff += Math.PI * 2
    return diff * REALIGN_PER_FRAME
  }

  /** 20 damage, or practice's 50 when the bullet flies roughly the way the
   *  target is facing (i.e. it hit them in the back). */
  private bulletDamage(b: Bullet, target: AsteroidsSession): number {
    const bulletAngle = Math.atan2(b.vy, b.vx)
    let diff = Math.abs(bulletAngle - target.angle)
    while (diff > Math.PI) diff -= Math.PI * 2
    return Math.abs(diff) < BACKSTAB_ANGLE ? BULLET_BACKSTAB_DAMAGE : BULLET_DAMAGE
  }

  private fireBullet(s: AsteroidsSession, now: number): void {
    if (this.bullets.size >= MAX_BULLETS) return // hard cap
    const id = this.nextBulletId++
    const cos = Math.cos(s.angle)
    const sin = Math.sin(s.angle)
    // Practice adds the ship's FORWARD velocity component to the muzzle
    // speed (never subtracts it when flying backwards).
    const forward = Math.max(0, s.vx * cos + s.vy * sin)
    const speed = BULLET_SPEED + forward
    // Muzzle sits just past the nose so a bullet can't spawn inside its own
    // ship's hit circle (practice offsets by 20).
    const muzzle = 20
    this.bullets.set(id, {
      id,
      ownerWallet: s.wallet,
      ownerId: s.id,
      x: s.x + cos * muzzle,
      y: s.y + sin * muzzle,
      vx: cos * speed,
      vy: sin * speed,
      diesAt: now + BULLET_TTL_MS,
    })
    s.ammo--
  }

  // ── interest-managed state ────────────────────

  protected buildState(session: AsteroidsSession, now: number): Record<string, unknown> {
    // Visible ships.
    this.shipScratch.length = 0
    const shipCandidates = this.shipGrid.query(
      session.x,
      session.y,
      this.viewRadius,
      this.shipScratch
    )
    const players: Array<Record<string, unknown>> = []
    for (const other of shipCandidates) {
      if (other === session || !other.alive) continue
      const dx = other.x - session.x
      const dy = other.y - session.y
      if (dx * dx + dy * dy > this.viewRadius * this.viewRadius) continue
      players.push({
        id: other.id, // opaque session id — never the wallet
        name: other.name,
        x: Math.round(other.x),
        y: Math.round(other.y),
        // Velocity so the client can extrapolate between 20 Hz frames.
        vx: Math.round(other.vx),
        vy: Math.round(other.vy),
        angle: Number(other.angle.toFixed(3)),
        hp: Math.round(other.hp),
        kills: other.kills,
        score: other.score,
      })
    }

    // Visible bullets (vx/vy included so the client can extrapolate).
    this.bulletScratch.length = 0
    const bulletCandidates = this.bulletGrid.query(
      session.x,
      session.y,
      this.viewRadius,
      this.bulletScratch
    )
    const bullets: Array<Record<string, unknown>> = []
    for (const b of bulletCandidates) {
      const dx = b.x - session.x
      const dy = b.y - session.y
      if (dx * dx + dy * dy > this.viewRadius * this.viewRadius) continue
      bullets.push({
        id: b.id,
        ownerId: b.ownerId,
        x: Math.round(b.x),
        y: Math.round(b.y),
        vx: Math.round(b.vx),
        vy: Math.round(b.vy),
      })
    }

    // Visible asteroids.
    this.rockScratch.length = 0
    const rockCandidates = this.asteroidGrid.query(
      session.x,
      session.y,
      this.viewRadius,
      this.rockScratch
    )
    const asteroids: Array<Record<string, unknown>> = []
    for (const rock of rockCandidates) {
      const dx = rock.x - session.x
      const dy = rock.y - session.y
      if (Math.hypot(dx, dy) - rock.r > this.viewRadius) continue
      asteroids.push({
        id: rock.id,
        x: Math.round(rock.x),
        y: Math.round(rock.y),
        r: Math.round(rock.r),
        vx: Math.round(rock.vx),
        vy: Math.round(rock.vy),
      })
    }

    return {
      t: now,
      you: {
        id: session.id,
        x: session.x,
        y: session.y,
        vx: session.vx,
        vy: session.vy,
        angle: session.angle,
        hp: Math.round(session.hp),
        ammo: session.ammo,
        magazine: session.ammo, // client alias
        reloading: session.reloadingUntil !== null,
        score: session.score,
        kills: session.kills,
        pot: session.pot,
        alive: session.alive,
        eliminated: session.eliminated,
        place: session.place,
        respawnIn: session.respawnAt ? Math.max(0, session.respawnAt - now) : 0,
        cashingOut: session.cashout !== 'none',
      },
      players,
      bullets,
      asteroids,
      leaderboard: this.leaderboard,
      zone: this.zoneState(),
    }
  }

  /**
   * The authoritative zone, shipped with every snapshot so clients RENDER it
   * instead of simulating a second copy. `null` = this world has no zone
   * (free play), which is the client's cue to draw nothing.
   *
   * Field names mirror the practice `zoneRef.current` so the client can
   * assign them straight across:
   *   x / y / radius   → zone.x / zone.y / zone.radius   (the live ring)
   *   safe             → zone.safeZone
   *   next             → zone.nextSafeZone
   *   shrinking        → zone.isShrinking
   *   phase            → zone.phase
   *   phaseTimer       → zone.phaseTimer (seconds left in this phase)
   *   countdown        → zone.countdownTimer (Blitz 3 s warning, else null)
   *   difficulty       → the practice difficulty code this match is running
   */
  private zoneState(): Record<string, unknown> | null {
    if (!this.zoneEnabled) return null
    return {
      x: Math.round(this.zoneX),
      y: Math.round(this.zoneY),
      radius: Math.round(this.zoneRadius),
      safe: {
        x: Math.round(this.safeZone.x),
        y: Math.round(this.safeZone.y),
        radius: Math.round(this.safeZone.radius),
      },
      next: this.nextSafeZone
        ? {
            x: Math.round(this.nextSafeZone.x),
            y: Math.round(this.nextSafeZone.y),
            radius: Math.round(this.nextSafeZone.radius),
          }
        : null,
      shrinking: this.isZoneShrinking,
      phase: this.zonePhase,
      phaseTimer: Number(Math.max(0, this.zonePhaseTimer).toFixed(2)),
      countdown:
        this.countdownTimer === null
          ? null
          : Number(Math.max(0, this.countdownTimer).toFixed(2)),
      difficulty: this.difficulty,
    }
  }
}
