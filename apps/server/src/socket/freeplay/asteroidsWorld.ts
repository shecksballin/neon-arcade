/**
 * ASTEROIDS WORLD — server-authoritative ship combat (free play v1)
 * =================================================================
 * Design contract scope: world 8000×8000 with [0, 8000] coords. Ships
 * auto-drive at a constant 260 u/s; the ONLY inputs are turn ∈ {-1,0,1}
 * (3.2 rad/s), a shoot flag (800 RPM, 30-round magazine, 1500 ms reload —
 * manual via flag or auto on empty) and a reload flag. Bullets fly at
 * 900 u/s for 1.2 s and deal 25 damage; hull is 100 hp with 5 hp/s regen
 * after 4 s without damage. ~60 asteroids (radius 60–160) drift around;
 * bullets are absorbed by them (v1: no shrink/split), and a SHIP touching
 * one is an ENVIRONMENT KILL — house takes the pot, status 'eliminated',
 * no respawn (money doc §4). Bullet kills go through World.resolveKill
 * (wagerService + per-kill ELO) and DO respawn after 2.5 s.
 *
 * Walls BOUNCE (reflect the heading) rather than wrap: the auto-drive ship
 * can never park against a wall, and plain Euclidean distances stay valid
 * everywhere (a torus would need seam-aware grids and view queries — not
 * worth it for a world this large in v1).
 *
 * The cash-out hold penalty applies to TURN RATE here (the ship auto-
 * drives, so speed is not the lever) — a holding ship turns at half rate.
 */

import type { Socket } from 'socket.io'
import { SpatialGrid } from './grid'
import { World, type FreeplayWorld } from './world'
import {
  VIEW_RADIUS,
  asteroidsInputSchema,
  type AsteroidsInput,
  type BaseSession,
  type WorldBounds,
} from './types'

// ─────────────────────────────────────────────────
// Tuning constants (contract values where specified)
// ─────────────────────────────────────────────────

const WORLD_SIZE = 8000
const BOUNDS: WorldBounds = { minX: 0, minY: 0, maxX: WORLD_SIZE, maxY: WORLD_SIZE }

/** Grid cell size 600 (contract) — ≈2× the largest asteroid diameter is
 *  ideal; 600 keeps bucket scans short for every entity class we store. */
const GRID_CELL = 600

// Ship
const SHIP_SPEED = 260 // u/s, constant auto-drive (contract)
const TURN_RATE = 3.2 // rad/s (contract)
const SHIP_RADIUS = 24
const MAX_HP = 100
const REGEN_PER_S = 5 // contract: 5 hp/s ...
const REGEN_DELAY_MS = 4000 // ... after 4 s without damage

// Guns (contract: 800 RPM, mag 30, reload 1500 ms)
const FIRE_INTERVAL_MS = 60_000 / 800 // = 75 ms between rounds
const MAG_SIZE = 30
const RELOAD_MS = 1500

// Bullets (contract: 900 u/s, 1.2 s ttl, 25 damage)
const BULLET_SPEED = 900
const BULLET_TTL_MS = 1200
const BULLET_DAMAGE = 25
const BULLET_RADIUS = 4
/** Hard cap on in-flight bullets (long-lived-process hygiene — §7 "cap
 *  unbounded collections"). At the cap the trigger simply does nothing. */
const MAX_BULLETS = 2000

// Asteroid field (contract: ~60 drifting, radius 60–160)
const ASTEROID_COUNT = 60
const ASTEROID_MIN_R = 60
const ASTEROID_MAX_R = 160
const ASTEROID_MIN_SPEED = 20
const ASTEROID_MAX_SPEED = 60

// Spawn safety
const SPAWN_ATTEMPTS = 15
const SAFE_SPAWN_SHIP_DIST = 600 // no other ship this close
const SAFE_SPAWN_ROCK_PAD = 300 // clearance beyond an asteroid's radius

// ─────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────

interface AsteroidsSession extends BaseSession<AsteroidsInput> {
  angle: number // heading in radians — server-owned, turned by input only
  hp: number
  ammo: number
  /** Non-null while reloading: the Date.now() when the mag refills. */
  reloadingUntil: number | null
  /** Fire-rate pacing anchor (see the catch-up loop in step()). */
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
  // Rebuilt every tick before collision resolution (money doc §3).
  private readonly shipGrid = new SpatialGrid<AsteroidsSession>(GRID_CELL)
  private readonly asteroidGrid = new SpatialGrid<Asteroid>(GRID_CELL)
  private readonly bulletGrid = new SpatialGrid<Bullet>(GRID_CELL)

  /** The permanent asteroid field — a fixed set of 60, drifting forever. */
  private readonly asteroids: Asteroid[] = []

  /** id → bullet, capped at MAX_BULLETS. */
  private readonly bullets = new Map<number, Bullet>()
  private nextBulletId = 1

  // Reused query scratch arrays (no per-query allocation).
  private readonly shipScratch: AsteroidsSession[] = []
  private readonly rockScratch: Asteroid[] = []
  private readonly bulletScratch: Bullet[] = []

  constructor(matchId: string, entryFee: number, bindings: Map<string, FreeplayWorld>) {
    super('asteroids', matchId, entryFee, BOUNDS, bindings)
    // Seed the drift field once — these rocks live as long as the process.
    for (let i = 0; i < ASTEROID_COUNT; i++) {
      const heading = Math.random() * Math.PI * 2
      const speed =
        ASTEROID_MIN_SPEED + Math.random() * (ASTEROID_MAX_SPEED - ASTEROID_MIN_SPEED)
      const r = ASTEROID_MIN_R + Math.random() * (ASTEROID_MAX_R - ASTEROID_MIN_R)
      this.asteroids.push({
        id: i + 1,
        x: r + Math.random() * (WORLD_SIZE - 2 * r),
        y: r + Math.random() * (WORLD_SIZE - 2 * r),
        r,
        vx: Math.cos(heading) * speed,
        vy: Math.sin(heading) * speed,
      })
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
      angle: 0,
      hp: MAX_HP,
      ammo: MAG_SIZE,
      reloadingUntil: null,
      lastShotAt: 0,
      lastDamagedAt: 0,
    }
  }

  /** Fresh life: full hull, full mag, random heading, safe random spot. */
  protected spawn(session: AsteroidsSession): void {
    session.r = SHIP_RADIUS
    session.hp = MAX_HP
    session.ammo = MAG_SIZE
    session.reloadingUntil = null
    session.lastShotAt = 0
    session.lastDamagedAt = 0
    session.angle = Math.random() * Math.PI * 2
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      session.x = 200 + Math.random() * (WORLD_SIZE - 400)
      session.y = 200 + Math.random() * (WORLD_SIZE - 400)
      if (this.isSpawnSafe(session)) break
      // last attempt keeps the final candidate — risky beats infinite
    }
  }

  /** Clear of every asteroid (+pad) and of other live ships. Scans the
   *  raw collections directly — spawns are rare, grids may be stale. */
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

  /** A leaver's bullets vanish with them — kill attribution can never
   *  point at a session that no longer exists (also a leak guard, §7). */
  protected override onDespawn(session: AsteroidsSession): void {
    for (const [id, b] of this.bullets) {
      if (b.ownerWallet === session.wallet) this.bullets.delete(id)
    }
  }

  // ── simulation ─────────────────────────────────

  protected step(now: number, dt: number): void {
    // 1) Asteroids drift (and bounce off the walls).
    for (const rock of this.asteroids) {
      rock.x += rock.vx * dt
      rock.y += rock.vy * dt
      if (rock.x - rock.r < 0) {
        rock.x = rock.r
        rock.vx = Math.abs(rock.vx)
      } else if (rock.x + rock.r > WORLD_SIZE) {
        rock.x = WORLD_SIZE - rock.r
        rock.vx = -Math.abs(rock.vx)
      }
      if (rock.y - rock.r < 0) {
        rock.y = rock.r
        rock.vy = Math.abs(rock.vy)
      } else if (rock.y + rock.r > WORLD_SIZE) {
        rock.y = WORLD_SIZE - rock.r
        rock.vy = -Math.abs(rock.vy)
      }
    }

    // 2) Ships: turn (input), auto-drive, wall bounce, regen.
    for (const s of this.sessions.values()) {
      if (!s.alive) continue
      const input = s.input
      if (input) {
        // Cash-out hold halves the TURN RATE (the asteroids penalty).
        s.angle += input.turn * TURN_RATE * this.moveScale(s) * dt
      }
      s.x += Math.cos(s.angle) * SHIP_SPEED * dt
      s.y += Math.sin(s.angle) * SHIP_SPEED * dt
      // Bounce: reflect the heading off the wall, clamp back inside.
      if (s.x < SHIP_RADIUS || s.x > WORLD_SIZE - SHIP_RADIUS) {
        s.angle = Math.PI - s.angle
        s.x = Math.min(WORLD_SIZE - SHIP_RADIUS, Math.max(SHIP_RADIUS, s.x))
      }
      if (s.y < SHIP_RADIUS || s.y > WORLD_SIZE - SHIP_RADIUS) {
        s.angle = -s.angle
        s.y = Math.min(WORLD_SIZE - SHIP_RADIUS, Math.max(SHIP_RADIUS, s.y))
      }
      // Hull regen after 4 s without damage.
      if (s.hp < MAX_HP && now - s.lastDamagedAt >= REGEN_DELAY_MS) {
        s.hp = Math.min(MAX_HP, s.hp + REGEN_PER_S * dt)
      }
    }

    // 3) Rebuild ship + asteroid grids at post-move positions.
    this.shipGrid.clear()
    this.asteroidGrid.clear()
    for (const s of this.sessions.values()) {
      if (s.alive) this.shipGrid.insert(s, s.x, s.y, SHIP_RADIUS)
    }
    for (const rock of this.asteroids) {
      this.asteroidGrid.insert(rock, rock.x, rock.y, rock.r)
    }

    // 4) Guns: reload state machine + rate-limited firing.
    for (const s of this.sessions.values()) {
      if (!s.alive) continue
      const input = s.input
      if (s.reloadingUntil !== null) {
        if (now >= s.reloadingUntil) {
          s.ammo = MAG_SIZE
          s.reloadingUntil = null
        }
      } else if (input?.reload && s.ammo < MAG_SIZE) {
        s.reloadingUntil = now + RELOAD_MS // manual reload via flag
      } else if (input?.shoot && s.ammo > 0) {
        // 800 RPM = one round per 75 ms, which doesn't divide the 50 ms
        // tick — so pace with an accumulator: fire every round that came
        // due since lastShotAt (at most 2 per tick), advancing the anchor
        // by exact intervals. The anchor is first clamped so a released
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

    // 5) Bullets: fly, expire, get eaten by rocks, hit ships.
    for (const [id, b] of this.bullets) {
      b.x += b.vx * dt
      b.y += b.vy * dt
      // Expired, or flew off the world (bullets don't bounce).
      if (
        now >= b.diesAt ||
        b.x < 0 ||
        b.x > WORLD_SIZE ||
        b.y < 0 ||
        b.y > WORLD_SIZE
      ) {
        this.bullets.delete(id)
        continue
      }
      // Asteroids absorb bullets (v1 — rocks don't shrink or split).
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
      // Ship hits: 25 damage; a hull at 0 is a pvp kill for the owner.
      this.shipScratch.length = 0
      const ships = this.shipGrid.query(b.x, b.y, BULLET_RADIUS, this.shipScratch)
      for (const target of ships) {
        if (!target.alive || target.wallet === b.ownerWallet) continue
        const dx = target.x - b.x
        const dy = target.y - b.y
        const hitDist = SHIP_RADIUS + BULLET_RADIUS
        if (dx * dx + dy * dy >= hitDist * hitDist) continue
        this.bullets.delete(id)
        target.hp -= BULLET_DAMAGE
        target.lastDamagedAt = now
        if (target.hp <= 0) {
          // Owner session always exists while its bullets do (despawn
          // removes them — see onDespawn), but stay defensive.
          const killer = this.sessions.get(b.ownerWallet)
          if (killer) this.resolveKill(killer, target)
        }
        break // one bullet, one hit
      }
    }

    // 6) Ship ↔ asteroid: the environment kill (house takes all, no
    // respawn — money doc §4). Checked AFTER bullets so a same-tick
    // bullet kill wins attribution; the DB status guard would make the
    // second settlement a no-op anyway.
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

    // 7) Bullet grid for the interest-managed broadcast (buildState).
    this.bulletGrid.clear()
    for (const b of this.bullets.values()) {
      this.bulletGrid.insert(b, b.x, b.y, BULLET_RADIUS)
    }
  }

  private fireBullet(s: AsteroidsSession, now: number): void {
    if (this.bullets.size >= MAX_BULLETS) return // hard cap (§7)
    const id = this.nextBulletId++
    const cos = Math.cos(s.angle)
    const sin = Math.sin(s.angle)
    // Muzzle sits just past the nose so a bullet can't spawn inside its
    // own ship's hit circle.
    const muzzle = SHIP_RADIUS + BULLET_RADIUS + 2
    this.bullets.set(id, {
      id,
      ownerWallet: s.wallet,
      ownerId: s.id,
      x: s.x + cos * muzzle,
      y: s.y + sin * muzzle,
      vx: cos * BULLET_SPEED,
      vy: sin * BULLET_SPEED,
      diesAt: now + BULLET_TTL_MS,
    })
    s.ammo--
  }

  // ── interest-managed state (money doc §3) ─────

  protected buildState(session: AsteroidsSession, now: number): Record<string, unknown> {
    // Visible ships.
    this.shipScratch.length = 0
    const shipCandidates = this.shipGrid.query(
      session.x,
      session.y,
      VIEW_RADIUS,
      this.shipScratch
    )
    const players: Array<Record<string, unknown>> = []
    for (const other of shipCandidates) {
      if (other === session || !other.alive) continue
      const dx = other.x - session.x
      const dy = other.y - session.y
      if (dx * dx + dy * dy > VIEW_RADIUS * VIEW_RADIUS) continue
      players.push({
        id: other.id, // opaque session id — never the wallet
        name: other.name,
        x: Math.round(other.x),
        y: Math.round(other.y),
        angle: Number(other.angle.toFixed(3)),
        hp: Math.round(other.hp),
        pot: other.pot, // §3: visible pots are the tension of the mode
      })
    }

    // Visible bullets (vx/vy included so the client can extrapolate
    // between 20 Hz snapshots).
    this.bulletScratch.length = 0
    const bulletCandidates = this.bulletGrid.query(
      session.x,
      session.y,
      VIEW_RADIUS,
      this.bulletScratch
    )
    const bullets: Array<Record<string, unknown>> = []
    for (const b of bulletCandidates) {
      const dx = b.x - session.x
      const dy = b.y - session.y
      if (dx * dx + dy * dy > VIEW_RADIUS * VIEW_RADIUS) continue
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
      VIEW_RADIUS,
      this.rockScratch
    )
    const asteroids: Array<Record<string, unknown>> = []
    for (const rock of rockCandidates) {
      const dx = rock.x - session.x
      const dy = rock.y - session.y
      if (Math.hypot(dx, dy) - rock.r > VIEW_RADIUS) continue
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
        angle: session.angle,
        hp: Math.round(session.hp),
        ammo: session.ammo,
        reloading: session.reloadingUntil !== null,
        pot: session.pot,
        kills: session.kills,
        alive: session.alive,
        respawnIn: session.respawnAt ? Math.max(0, session.respawnAt - now) : 0,
        cashingOut: session.cashout !== 'none',
      },
      players,
      bullets,
      asteroids,
      leaderboard: this.leaderboard,
    }
  }
}
