// src/lib/freeplayNet.ts
// Free-play (permanent server) client netcode shared by Neon Cells + Neon Asteroids.
//
// One FreeplayNet instance = one paid free-play session on the server. It owns:
//   - join/leave lifecycle over the shared authenticated game socket
//   - a 20Hz input pump (setInterval 50ms, last-write-wins snapshot of local input)
//   - a 2-deep snapshot buffer of `freeplay:state` frames (+ local receive timestamps)
//   - interpolate(nowMs): render-ready entities lerped ~100ms behind the newest state
//   - the manual cash-out emits (confirmation comes ONLY from the server)
//
// The server is fully authoritative: this class never simulates anything, it only
// smooths what the server said between two known frames. Money never touches
// NeonBucks here — pots are SOL-denominated ledger values echoed for display.
import type { Socket } from 'socket.io-client';
import { getSocket, connectGameSocket } from '../hooks/useGameSocket';

export type FreeplayGame = 'cells' | 'asteroids';

/** Payload of `freeplay:joined`. */
export interface FreeplayJoinedInfo {
  matchId: string;
  playerId: string; // opaque per-session id (NOT the wallet)
  entryFee: number;
  world: { w: number; h: number; game: FreeplayGame };
  tick: number;
}

/**
 * A networked entity as the server describes it. Field names follow the design
 * contract (`r` for cells radius, `angle` for asteroids heading); everything is
 * optional because the two games share this shape and servers may add fields.
 */
export interface NetEntity {
  id: string;
  name?: string;
  x: number;
  y: number;
  r?: number;        // cells: circle radius
  radius?: number;   // tolerated alias
  angle?: number;    // asteroids: ship heading (radians)
  pot?: number;
  kills?: number;
  health?: number;
  hp?: number;       // server's canonical asteroids hull field (see freeplay/asteroidsWorld.ts)
  mass?: number;
  score?: number;
  boosting?: boolean;
  ammo?: number;     // server's canonical asteroids magazine field
  magazine?: number;
  mag?: number;      // tolerated alias
  reloading?: boolean;
  [key: string]: unknown;
}

export interface NetFood {
  id: string | number;
  x: number;
  y: number;
  radius?: number;
  color?: string;
}

export interface NetBullet {
  id?: string | number;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  angle?: number;   // derived client-side from motion when the server omits it
  ownerId?: string;
  [key: string]: unknown;
}

export interface NetLeaderboardEntry {
  name: string;
  pot: number;
}

/** What interpolate() hands back to the game's render adapter every frame. */
export interface InterpolatedWorld {
  you: NetEntity | null;          // own full state (null while dead/despawned)
  players: NetEntity[];           // OTHER visible players (self filtered out)
  asteroids: NetEntity[];         // asteroids game only, else []
  bullets: NetBullet[];           // asteroids game only, else []
  food: NetFood[];                // cells game only (accumulated from deltas), else []
  leaderboard: NetLeaderboardEntry[];
}

/** Server->client session events a game component can subscribe to. */
export interface FreeplayEvents {
  onJoined?: (info: FreeplayJoinedInfo) => void;
  onPot?: (p: { pot: number; kills: number }) => void;
  onKill?: (p: { victimName: string; earned: number }) => void;
  onKilled?: (p: { by: string; potLost: number; respawnIn: number }) => void;
  onRespawn?: (p: { pot: number }) => void;
  onEliminated?: (p: { reason: string; potLost: number }) => void;
  onCashoutConfirmed?: (p: { payout: number; kills: number }) => void;
  onError?: (p: { code: string; message?: string }) => void;
}

export interface CellsInput {
  dx: number;               // normalized mouse direction, -1..1
  dy: number;
  boost?: boolean;
}
export interface AsteroidsInput {
  turn: -1 | 0 | 1;
  shoot?: boolean;
  reload?: boolean;
}
export type FreeplayInput = CellsInput | AsteroidsInput;

/** One buffered `freeplay:state` frame plus when WE received it. */
interface StateFrame {
  t: number;                       // server tick timestamp (informational)
  recvAt: number;                  // performance.now() at receipt — interpolation basis
  you: NetEntity | null;
  players: NetEntity[];
  asteroids: NetEntity[];
  bullets: NetBullet[];
  leaderboard: NetLeaderboardEntry[];
}

const INPUT_INTERVAL_MS = 50;      // 20Hz, matches the server tick
const RENDER_DELAY_MS = 100;       // how far behind the newest state we render

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Shortest-path angle lerp so ships don't spin the long way round. */
const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/** Lerp every numeric pose field of an entity between two server frames. */
function lerpEntity(prev: NetEntity | undefined, next: NetEntity, t: number): NetEntity {
  if (!prev) return next; // just entered view — snap, nothing to lerp from
  const out: NetEntity = { ...next };
  out.x = lerp(prev.x, next.x, t);
  out.y = lerp(prev.y, next.y, t);
  const pr = prev.r ?? prev.radius;
  const nr = next.r ?? next.radius;
  if (pr !== undefined && nr !== undefined) out.r = lerp(pr, nr, t);
  if (prev.angle !== undefined && next.angle !== undefined) {
    out.angle = lerpAngle(prev.angle, next.angle, t);
  }
  return out;
}

export class FreeplayNet {
  readonly game: FreeplayGame;

  private socket: Socket;
  private active = false;          // join() called and not yet torn down
  private events: FreeplayEvents = {};
  private joined: FreeplayJoinedInfo | null = null;

  // Snapshot buffer: exactly the last 2 state frames (design contract).
  private prevFrame: StateFrame | null = null;
  private latestFrame: StateFrame | null = null;

  // Cells food accumulates from {added, removed} deltas keyed by id.
  private foodMap = new Map<string | number, NetFood>();
  private foodArrayCache: NetFood[] = [];
  private foodDirty = false;

  // Bullet headings derived from frame-to-frame motion (server may omit angles).
  private bulletAngles = new Map<string | number, number>();

  // Latest local input, resent every 50ms (last-write-wins on the server too).
  private input: FreeplayInput;
  private inputTimer: ReturnType<typeof setInterval> | null = null;

  // If the server never answers the join (no token, server down, rejected
  // handshake), surface an error instead of leaving the game stuck "linking".
  private joinTimeout: ReturnType<typeof setTimeout> | null = null;

  // Bound handlers so we can socket.off() EXACTLY ours (the socket is shared).
  private boundHandlers: Array<[string, (...args: any[]) => void]> = [];

  constructor(game: FreeplayGame) {
    this.game = game;
    this.socket = getSocket();
    this.input = game === 'cells' ? { dx: 0, dy: 0, boost: false } : { turn: 0, shoot: false, reload: false };
  }

  get joinedInfo(): FreeplayJoinedInfo | null {
    return this.joined;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Join the permanent free-play world. Emits are buffered by socket.io until
   * the (re)connect completes, so this is safe to call before the socket is up.
   * On reconnect the same wallet re-joining RESUMES the server-side session,
   * so we re-emit `freeplay:join` from the connect handler too.
   */
  join(events: FreeplayEvents): void {
    if (this.active) return;
    this.active = true;
    this.events = events;

    const on = (event: string, handler: (...args: any[]) => void) => {
      this.boundHandlers.push([event, handler]);
      this.socket.on(event, handler);
    };

    on('freeplay:joined', (payload: FreeplayJoinedInfo) => {
      if (!payload || typeof payload !== 'object') return;
      if (this.joinTimeout !== null) {
        clearTimeout(this.joinTimeout);
        this.joinTimeout = null;
      }
      this.joined = payload;
      this.events.onJoined?.(payload);
    });

    on('freeplay:state', (payload: any) => {
      if (!payload || typeof payload !== 'object') return;
      this.pushState(payload);
    });

    on('freeplay:pot', (p: any) => this.events.onPot?.({ pot: Number(p?.pot ?? 0), kills: Number(p?.kills ?? 0) }));
    on('freeplay:kill', (p: any) => this.events.onKill?.({ victimName: String(p?.victimName ?? 'UNKNOWN'), earned: Number(p?.earned ?? 0) }));
    on('freeplay:killed', (p: any) =>
      this.events.onKilled?.({ by: String(p?.by ?? 'UNKNOWN'), potLost: Number(p?.potLost ?? 0), respawnIn: Number(p?.respawnIn ?? 2500) }));
    on('freeplay:respawn', (p: any) => this.events.onRespawn?.({ pot: Number(p?.pot ?? p?.respawnPot ?? 0) }));
    on('freeplay:eliminated', (p: any) =>
      this.events.onEliminated?.({ reason: String(p?.reason ?? 'eliminated'), potLost: Number(p?.potLost ?? 0) }));
    on('freeplay:cashout_confirmed', (p: any) =>
      this.events.onCashoutConfirmed?.({ payout: Number(p?.payout ?? 0), kills: Number(p?.kills ?? 0) }));
    on('freeplay:error', (p: any) =>
      this.events.onError?.({ code: String(p?.code ?? 'unknown'), message: p?.message ? String(p.message) : undefined }));

    // Re-join on every (re)connect while the session is live — the server's
    // 60s disconnect grace turns this into a seamless resume.
    on('connect', () => {
      if (this.active) this.socket.emit('freeplay:join', { game: this.game });
    });

    connectGameSocket();
    if (this.socket.connected) {
      // Already connected: the 'connect' handler above won't fire, emit now.
      this.socket.emit('freeplay:join', { game: this.game });
    }

    // 20Hz input pump. The server treats inputs as last-write-wins per tick,
    // so re-sending an unchanged input every 50ms is the simplest correct thing.
    this.inputTimer = setInterval(() => {
      if (this.active && this.socket.connected) {
        this.socket.emit('freeplay:input', this.input);
      }
    }, INPUT_INTERVAL_MS);

    // Join watchdog: no `freeplay:joined` within 8s means we never reached the
    // world (missing token, rejected handshake, server down). freeplay:error
    // covers server-side refusals; this covers the silent failure modes.
    this.joinTimeout = setTimeout(() => {
      this.joinTimeout = null;
      if (this.active && !this.joined) {
        this.events.onError?.({
          code: 'join_timeout',
          message: 'Could not reach the game server — sign in and try again',
        });
      }
    }, 8000);
  }

  /** Merge new values into the input snapshot sent by the 20Hz pump. */
  setInput(partial: Partial<FreeplayInput>): void {
    this.input = { ...this.input, ...partial } as FreeplayInput;
  }

  /** Player pressed the hold-to-cashout button — server starts the 3s timer. */
  startCashout(): void {
    if (this.active) this.socket.emit('freeplay:cashout_start');
  }

  /** Player released early — server aborts the hold. */
  cancelCashout(): void {
    if (this.active) this.socket.emit('freeplay:cashout_cancel');
  }

  /**
   * Voluntary exit: server despawns us and auto-cashes-out the current pot.
   * Use dispose() instead when the session already ended server-side
   * (eliminated / cashout confirmed) to avoid a pointless leave emit.
   */
  leave(): void {
    if (this.active && this.socket.connected) {
      this.socket.emit('freeplay:leave');
    }
    this.dispose();
  }

  /** Tear down listeners/timers WITHOUT emitting anything. Idempotent. */
  dispose(): void {
    this.active = false;
    if (this.inputTimer !== null) {
      clearInterval(this.inputTimer);
      this.inputTimer = null;
    }
    if (this.joinTimeout !== null) {
      clearTimeout(this.joinTimeout);
      this.joinTimeout = null;
    }
    for (const [event, handler] of this.boundHandlers) {
      this.socket.off(event, handler);
    }
    this.boundHandlers = [];
    this.prevFrame = null;
    this.latestFrame = null;
    this.foodMap.clear();
    this.foodArrayCache = [];
    this.bulletAngles.clear();
    // NOTE: never disconnect the shared socket here — other games use it.
  }

  /** Ingest one `freeplay:state` frame: rotate the 2-deep buffer, apply food deltas. */
  private pushState(payload: any): void {
    const frame: StateFrame = {
      t: Number(payload.t ?? 0),
      recvAt: performance.now(),
      you: payload.you && typeof payload.you === 'object' ? (payload.you as NetEntity) : null,
      players: Array.isArray(payload.players) ? (payload.players as NetEntity[]) : [],
      asteroids: Array.isArray(payload.asteroids) ? (payload.asteroids as NetEntity[]) : [],
      bullets: Array.isArray(payload.bullets) ? (payload.bullets as NetBullet[]) : [],
      leaderboard: Array.isArray(payload.leaderboard)
        ? payload.leaderboard.map((l: any) => ({ name: String(l?.name ?? '?'), pot: Number(l?.pot ?? 0) }))
        : [],
    };
    this.prevFrame = this.latestFrame;
    this.latestFrame = frame;

    // Cells food arrives as deltas {added:[{id,x,y,...}], removed:[ids]}.
    // Food never moves, so it lives outside the interpolation buffer.
    const food = payload.food;
    if (food && typeof food === 'object') {
      if (Array.isArray(food.added)) {
        for (const f of food.added) {
          if (f && f.id !== undefined) {
            this.foodMap.set(f.id, f as NetFood);
            this.foodDirty = true;
          }
        }
      }
      if (Array.isArray(food.removed)) {
        for (const id of food.removed) {
          if (this.foodMap.delete(id)) this.foodDirty = true;
        }
      }
    }

    // Refresh derived bullet headings + prune stale ids.
    if (frame.bullets.length > 0 || this.bulletAngles.size > 0) {
      const seen = new Set<string | number>();
      const prevById = new Map<string | number, NetBullet>();
      if (this.prevFrame) {
        for (const b of this.prevFrame.bullets) {
          if (b.id !== undefined) prevById.set(b.id, b);
        }
      }
      for (const b of frame.bullets) {
        if (b.id === undefined) continue;
        seen.add(b.id);
        if (typeof b.angle === 'number') {
          this.bulletAngles.set(b.id, b.angle);
        } else if (typeof b.vx === 'number' && typeof b.vy === 'number' && (b.vx !== 0 || b.vy !== 0)) {
          this.bulletAngles.set(b.id, Math.atan2(b.vy, b.vx));
        } else {
          const p = prevById.get(b.id);
          if (p && (p.x !== b.x || p.y !== b.y)) {
            this.bulletAngles.set(b.id, Math.atan2(b.y - p.y, b.x - p.x));
          }
        }
      }
      for (const id of this.bulletAngles.keys()) {
        if (!seen.has(id)) this.bulletAngles.delete(id);
      }
    }
  }

  /**
   * Produce render-ready entities for `nowMs` (performance.now() basis).
   *
   * We render RENDER_DELAY_MS behind the newest snapshot so there is always a
   * "next" frame to lerp toward. With only two 20Hz frames buffered, a full
   * 100ms reach-back can land BEFORE the older frame; in that steady-state case
   * we fall back to spreading the newest frame's motion across the following
   * inter-frame interval — visually identical smoothness, effective delay of
   * roughly one server tick. Returns null until the first state arrives.
   */
  interpolate(nowMs: number): InterpolatedWorld | null {
    const latest = this.latestFrame;
    if (!latest) return null;
    const prev = this.prevFrame;

    let alpha = 1;
    if (prev && latest.recvAt > prev.recvAt) {
      const span = latest.recvAt - prev.recvAt;
      alpha = (nowMs - RENDER_DELAY_MS - prev.recvAt) / span;
      if (alpha < 0) {
        // Buffer shorter than the render delay (normal at a steady 50ms cadence):
        // progress prev -> latest over one interval starting when latest arrived.
        alpha = (nowMs - latest.recvAt) / span;
      }
      alpha = Math.max(0, Math.min(1, alpha));
    }

    // Index the previous frame's entities by id for pairing.
    const prevPlayers = new Map<string, NetEntity>();
    const prevAsteroids = new Map<string | number, NetEntity>();
    const prevBullets = new Map<string | number, NetBullet>();
    if (prev) {
      for (const p of prev.players) prevPlayers.set(p.id, p);
      for (const a of prev.asteroids) if (a.id !== undefined) prevAsteroids.set(a.id, a);
      for (const b of prev.bullets) if (b.id !== undefined) prevBullets.set(b.id, b);
    }

    const myId = this.joined?.playerId;

    // Own state: lerp against the previous frame's `you` when both exist.
    const you = latest.you ? lerpEntity(prev?.you ?? undefined, latest.you, alpha) : null;

    // Other players (defensively drop self if the server includes us in the list).
    const players: NetEntity[] = [];
    for (const p of latest.players) {
      if (myId !== undefined && p.id === myId) continue;
      players.push(lerpEntity(prevPlayers.get(p.id), p, alpha));
    }

    const asteroids = latest.asteroids.map((a) =>
      a.id !== undefined ? lerpEntity(prevAsteroids.get(a.id), a, alpha) : a
    );

    const bullets: NetBullet[] = latest.bullets.map((b) => {
      const p = b.id !== undefined ? prevBullets.get(b.id) : undefined;
      const out: NetBullet = { ...b };
      if (p) {
        out.x = lerp(p.x, b.x, alpha);
        out.y = lerp(p.y, b.y, alpha);
      }
      if (out.angle === undefined && b.id !== undefined) {
        out.angle = this.bulletAngles.get(b.id);
      }
      return out;
    });

    // Food array is rebuilt only when a delta actually changed the map, so the
    // consumer can use array identity to skip re-mapping unchanged food.
    if (this.foodDirty) {
      this.foodArrayCache = Array.from(this.foodMap.values());
      this.foodDirty = false;
    }

    return {
      you,
      players,
      asteroids,
      bullets,
      food: this.foodArrayCache,
      leaderboard: latest.leaderboard,
    };
  }
}
