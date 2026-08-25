// src/lib/freeplayNet.ts
// Online (server-authoritative) client netcode shared by Neon Cells + Neon Asteroids.
//
// ONE FreeplayNet instance = one online session. It owns:
//   - join/queue/leave lifecycle over the shared authenticated game socket
//   - a 20Hz input pump (setInterval 50ms, last-write-wins snapshot of local input)
//   - a small ring buffer of `freeplay:state` frames (+ local receive timestamps)
//   - interpolate(nowMs): render-ready entities, remote players smoothly
//     interpolated on a MONOTONIC render clock, the LOCAL player rendered from
//     client-side prediction and reconciled against the server
//   - NO MONEY. This pass has no wager, no stake, no pot. The pot/cash-out
//     emits are kept only so the server contract stays source-compatible; the
//     games no longer show or use them.
//
// ---------------------------------------------------------------------------
// WIRE CONTRACT (client half — the server half is owned by the freeplay module)
// ---------------------------------------------------------------------------
// There are three online modes, exactly mirroring the practice lobby:
//
//   free_play — the PERMANENT world. Join anytime, no queue, no searching UI.
//     C→S  freeplay:join   { game, mode: 'free_play' }
//     S→C  freeplay:joined { matchId, playerId, world:{w,h,game}, tick, ... }
//
//   slayer / lms — MATCH-SCOPED lobby worlds (queue first, then a world with
//   only the humans that queued; no bots). A queued session ALWAYS carries a
//   SECTOR ('eclipse' | 'blitz'); (sector, mode) is what the server turns into
//   the practice difficulty code (10/11/12/13) the zone rules key off.
//     C→S  freeplay:find   { game, mode, sector }  // idempotent, re-sendable
//     S→C  queue:status    { game, mode, inQueue, current, needed }   (shared
//                          socket/queue.ts payload; `mode` is the queue key,
//                          i.e. 'eclipse:slayer' — see the filter below)
//     S→C  freeplay:joined { ..., sector, difficulty }  // "your match exists"
//     C→S  freeplay:cancel { game, mode, sector }  // leave the queue
//
// Everything after `freeplay:joined` is identical for all three modes:
//   S→C  freeplay:state, freeplay:kill, freeplay:killed, freeplay:respawn,
//        freeplay:eliminated, freeplay:error
//   C→S  freeplay:input, freeplay:leave
//
// Match-scoped worlds additionally report their lifecycle:
//   S→C  freeplay:match_found { startsIn, players }
//   S→C  freeplay:match_state { status:'waiting'|'running'|'ended',
//                               alive, total, startsIn }
//   S→C  freeplay:match_end   { reason, winner:{id,name}|null, standings[] }
//
// The client NEVER waits for a server ack to show its searching screen — the
// searching state is set optimistically the moment join() is called (verified
// root cause of "online refuses to search").
import type { Socket } from 'socket.io-client';
import { getSocket, connectGameSocket } from '../hooks/useGameSocket';

export type FreeplayGame = 'cells' | 'asteroids';

/** The three online modes — the SAME three the practice lobby offers. */
export type FreeplayMode = 'free_play' | 'slayer' | 'lms';

/**
 * The two ONLINE sectors, mirroring the practice difficulty selectors
 * (`free`/INFINITE is deliberately absent — free play is the permanent
 * drop-in world, never a queue). (sector, mode) → practice difficulty code:
 *   eclipse: slayer 10, lms 11   ·   blitz: slayer 12, lms 13
 * The SERVER derives that number and sends it back; the client never picks it.
 */
export type FreeplaySector = 'eclipse' | 'blitz';

/** Lobby (queued) modes need a match; free play joins the permanent world. */
export const isQueuedMode = (mode: FreeplayMode): boolean => mode !== 'free_play';

/** No-zone ruleset (practice INFINITE / the permanent free-play world). */
export const FREE_PLAY_DIFFICULTY = 1;

/** Payload of `freeplay:joined`. */
export interface FreeplayJoinedInfo {
  matchId: string;
  playerId: string; // opaque per-session id (NOT the wallet)
  entryFee: number; // legacy field — no money is used this pass
  world: {
    w: number;
    h: number;
    game: FreeplayGame;
    /** True server frame — cells is origin-centred (-3000..3000), asteroids
     *  zero-based. Never assume [0,w]x[0,h]. */
    bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  };
  tick: number;
  mode?: FreeplayMode;
  /** Lobby matches: ms until the first simulated tick (0 once running). */
  startsIn?: number;
  /** Lobby matches: the human roster (no bots, ever). */
  players?: Array<{ id: string; name: string }>;
  status?: MatchStatus;
  /** Which sector the server put us in (null for the permanent world). */
  sector?: FreeplaySector | null;
  /**
   * THE PRACTICE DIFFICULTY CODE THE SERVER IS RUNNING (10/11/12/13, or 1 for
   * free play). The games render their zone off this number exactly as
   * practice does — nothing client-side may invent it.
   */
  difficulty?: number;
}

/** Lifecycle of a match-scoped world (the permanent world is always running). */
export type MatchStatus = 'waiting' | 'running' | 'ended';

/** `freeplay:match_state` — countdown + alive count for the match overlay. */
export interface MatchState {
  status: MatchStatus;
  alive: number;
  total: number;
  startsIn: number;
}

/** One row of the end-of-match scoreboard (`freeplay:match_end`). */
export interface MatchStanding {
  id: string;
  name: string;
  kills: number;
  score: number;
  /** The number the row is RANKED on — slayer: kills, lms: score. */
  points: number;
  /** LMS: 1 = winner. SLAYER: a kill RANKING only — place 1 is NOT a win. */
  place: number;
  alive: boolean;
  /** True for OUR row (the client's own session). */
  isYou: boolean;
}

/**
 * How the end screen must read the standings:
 *   'kills'    — SLAYER: nobody won, everyone scores their kills.
 *   'survival' — LMS: the usual victory/defeat verdict.
 */
export type MatchScoring = 'kills' | 'survival';

/** What the game gets when a match-scoped world finishes. */
export interface MatchResult {
  /** ALWAYS false when scoring is 'kills' — slayer has no winner. */
  won: boolean;
  winnerName: string | null;
  reason: string;
  standings: MatchStanding[];
  /** Our finishing position, 1 = winner in LMS / top killer in slayer. */
  place: number | null;
  /** Which end screen to render (see MatchScoring). */
  scoring: MatchScoring;
  /** Our own kill count, for the slayer scoreboard headline. */
  kills: number;
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
  hp?: number;       // server's canonical asteroids hull field
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
  /** Kills/score — the online HUD shows this; `pot` is legacy and unused. */
  score: number;
  pot: number;
  kills: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// ▼▼▼  SERVER ZONE STATE — THE ONE PLACE THE WIRE NAMES LIVE  ▼▼▼
//
// The shrinking safe zone is simulated SERVER-SIDE (apps/server/src/socket/
// freeplay/{cellsWorld,asteroidsWorld}.ts) and broadcast inside every
// `freeplay:state` snapshot. The games render straight off this — there is
// deliberately NO second local zone simulation online, because two sims
// drifting apart is exactly how a player dies to a ring they cannot see.
//
// If the server's field names change, `parseNetZone` below is the ONLY thing
// that has to move. The parser accepts the obvious aliases so a rename on the
// server half cannot silently blank the zone on the client half.
//
// Expected wire shape (state.zone):
//   { x, y, radius,
//     next: { x, y, radius } | null,      // the target ring being shrunk to
//     shrinking: boolean,                 // moving vs stable phase
//     phase: number,                      // 1-based phase counter
//     phaseTimer: number,                 // SECONDS left in this phase
//     countdown: number | null,           // Blitz 3-2-1 before a shrink
//     outsideTimer: number,               // seconds of grace burnt outside
//     maxOutsideTime: number }            // 0 = instant kill (Eclipse/Blitz)
// ═══════════════════════════════════════════════════════════════════════════

/** A circle on the wire (current zone / next zone). */
export interface NetZoneCircle {
  x: number;
  y: number;
  radius: number;
}

/** The server's authoritative zone state for one snapshot. */
export interface NetZone extends NetZoneCircle {
  next: NetZoneCircle | null;
  shrinking: boolean;
  phase: number;
  phaseTimer: number;
  countdown: number | null;
  outsideTimer: number;
  maxOutsideTime: number;
}

const num = (...vals: unknown[]): number | null => {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
};

/** Parse a `{x,y,radius}` circle with the tolerated aliases. */
function parseZoneCircle(raw: any): NetZoneCircle | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = num(raw.x, raw.cx, raw.centerX, raw.centreX);
  const y = num(raw.y, raw.cy, raw.centerY, raw.centreY);
  const radius = num(raw.radius, raw.r, raw.rad);
  if (x === null || y === null || radius === null) return null;
  return { x, y, radius };
}

/**
 * Pull the zone out of a `freeplay:state` payload. Returns null when the
 * world has no zone (free play / difficulty 1) or the server did not send one
 * — in which case the games draw nothing, exactly like practice difficulty 1.
 */
export function parseNetZone(payload: any): NetZone | null {
  const raw = payload?.zone ?? payload?.safeZone ?? null;
  const circle = parseZoneCircle(raw);
  if (!circle) return null;
  const phaseTimerMs = num(raw.phaseTimerMs, raw.phaseRemainingMs);
  return {
    ...circle,
    next: parseZoneCircle(raw.next ?? raw.nextZone ?? raw.nextSafeZone ?? raw.target),
    shrinking: !!(raw.shrinking ?? raw.isShrinking ?? raw.isZoneShrinking),
    phase: num(raw.phase, raw.zonePhase) ?? 1,
    phaseTimer:
      num(raw.phaseTimer, raw.zonePhaseTimer, raw.timer, raw.phaseRemaining) ??
      (phaseTimerMs !== null ? phaseTimerMs / 1000 : 0),
    countdown: num(raw.countdown, raw.countdownTimer, raw.shrinkCountdown),
    outsideTimer: num(raw.outsideTimer, raw.outside, raw.outsideFor) ?? 0,
    maxOutsideTime: num(raw.maxOutsideTime, raw.maxOutside) ?? 0,
  };
}

/** Lerp two zone snapshots so a shrinking ring never steps at 20Hz. */
function lerpZone(prev: NetZone | null, next: NetZone, t: number): NetZone {
  if (!prev) return next;
  const out: NetZone = {
    ...next,
    x: lerp(prev.x, next.x, t),
    y: lerp(prev.y, next.y, t),
    radius: lerp(prev.radius, next.radius, t),
  };
  if (prev.next && next.next) {
    out.next = {
      x: lerp(prev.next.x, next.next.x, t),
      y: lerp(prev.next.y, next.next.y, t),
      radius: lerp(prev.next.radius, next.next.radius, t),
    };
  }
  return out;
}
// ═══════════════════════════════════════════════════════════════════════════
// ▲▲▲  END SERVER ZONE STATE  ▲▲▲
// ═══════════════════════════════════════════════════════════════════════════

/** What interpolate() hands back to the game's render adapter every frame. */
export interface InterpolatedWorld {
  you: NetEntity | null;          // own full state (null while dead/despawned)
  players: NetEntity[];           // OTHER visible players (self filtered out)
  asteroids: NetEntity[];         // asteroids game only, else []
  bullets: NetBullet[];           // asteroids game only, else []
  food: NetFood[];                // cells game only (accumulated from deltas), else []
  leaderboard: NetLeaderboardEntry[];
  /** The server's authoritative zone (null = no zone in this world). */
  zone: NetZone | null;
}

/** Live queue readout for the shared SEARCHING FOR ONLINE MATCH screen. */
export interface FreeplayQueueStatus {
  inQueue: boolean;
  current: number;
  needed: number;
  /** FFA early-start vote (fill-first queues; see SearchingForMatch). */
  voteOpen?: boolean;
  votes?: number;
  votesNeeded?: number;
}

/** Server->client session events a game component can subscribe to. */
export interface FreeplayEvents {
  /** The match started (lobby modes) / we entered the world (free play). */
  onJoined?: (info: FreeplayJoinedInfo) => void;
  /** Live queue counts while searching (lobby modes only). */
  onQueue?: (status: FreeplayQueueStatus) => void;
  onPot?: (p: { pot: number; kills: number }) => void;
  onKill?: (p: { victimName: string; earned: number }) => void;
  onKilled?: (p: { by: string; potLost: number; respawnIn: number }) => void;
  onRespawn?: (p: { pot: number }) => void;
  onEliminated?: (p: { reason: string; potLost: number }) => void;
  /** Match-scoped worlds: the roster closed and the countdown started. */
  onMatchFound?: (p: { startsIn: number; players: Array<{ id: string; name: string }> }) => void;
  /** Match-scoped worlds: countdown / alive-count ticks. */
  onMatchState?: (state: MatchState) => void;
  /** Match-scoped worlds: the whole match ended (result screen). */
  onMatchEnd?: (result: MatchResult) => void;
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
  zone: NetZone | null;            // server-authoritative safe zone (see above)
}

const INPUT_INTERVAL_MS = 50;      // 20Hz, matches the server tick

/**
 * How far behind the newest snapshot remote entities are rendered. 120ms =
 * ~2.4 server ticks of slack, so ordinary packet jitter never runs the buffer
 * dry (an empty buffer is what made everything stutter before).
 */
const RENDER_DELAY_MS = 120;

/** Frames kept for interpolation (~400ms of history at 20Hz). */
const MAX_FRAMES = 8;

/** How fast the min-filtered clock offset may creep upward, per snapshot.
 *  0.02ms × 20Hz = 0.4ms/s — enough for real drift, immune to one fast packet. */
const CLOCK_DRIFT_PER_FRAME = 0.02;

/** Max playback-clock correction per ms of real time (0.25 = ±25% speed).
 *  Keeps the render clock monotonic while a better offset eases in. */
const OFFSET_SLEW = 0.25;

// ── Local-player prediction ────────────────────────────────────────────────
// The local player is NOT interpolated: we re-run the SAME simulation the
// server runs, from the same input, and pull gently back onto the server's
// truth every frame. That removes 100% of the snapshot jitter on the one
// entity the camera is locked to, and makes steering feel like practice
// instead of like a 20Hz slideshow.
//
// These constants are the PRACTICE constants, and the server worlds
// (apps/server/src/socket/freeplay/{cellsWorld,asteroidsWorld}.ts) are written
// from the same numbers and step the same fixed 1/60s frames — so client and
// server integrate identically and the correction stays near zero. If a server
// constant is ever retuned, change it here in the same commit.

/** Both sims advance in fixed practice frames of 1/60 s. */
const FRAME_DT = 1 / 60;
/** Never simulate more than this many frames in one render tick (tab wake-up). */
const MAX_PREDICT_FRAMES = 6;

// Cells (practice `updatePlayer`): v += (3.6/√r)·45 per frame, v ×= 0.9,
// x += v·dt. Boost multiplies the acceleration by 1.65.
const CELLS_ACCEL_NUM = 3.6 * 45;
const CELLS_VEL_DECAY = 0.9;
const CELLS_BOOST_MULT = 1.65;
const CELLS_DEADZONE = 0.05;

// Asteroids (practice player block): per-frame angular accel/friction with a
// clamp, constant forward thrust, velocity friction, and the auto-realign pull
// toward the nearest of north/south while not turning.
const AST_TURN_ACCEL_PER_FRAME = 0.008 * 60;
const AST_MAX_TURN_RATE = 0.16 * 60;
const AST_ANG_FRICTION = 0.88;
const AST_THRUST_PER_FRAME = 0.2 * 60;
const AST_VEL_FRICTION = 0.98;
const AST_REALIGN_PER_FRAME = 0.003 * 60;

/** How fast prediction error is bled off (per second, exponential). */
const RECONCILE_RATE = 6;
/** Divergence beyond this (world units) is a teleport (respawn/kill) — snap. */
const SNAP_DIST = 260;
/** Radius/size changes are smoothed at this rate so eating never pops. */
const RADIUS_RATE = 10;

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

/** Local dead-reckoned state for the player we control (server units). */
interface Prediction {
  x: number;
  y: number;
  vx: number;          // u/s, exactly like the server session
  vy: number;
  angle: number;       // asteroids heading
  av: number;          // asteroids angular velocity, rad/s
  r: number;           // smoothed render radius
  /** Time not yet consumed by a whole 1/60s frame. */
  accum: number;
  /** Cells: server-side boost bank non-empty (mirrors you.boostRemaining). */
  boostOk?: boolean;
}

/** Practice's "realign the jet" pull toward the nearest of north/south. */
function realignDelta(angle: number): number {
  let norm = angle % (Math.PI * 2);
  if (norm > Math.PI) norm -= Math.PI * 2;
  if (norm < -Math.PI) norm += Math.PI * 2;
  const north = -Math.PI / 2;
  const south = Math.PI / 2;
  const target = Math.abs(norm - north) < Math.abs(norm - south) ? north : south;
  let diff = target - norm;
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff * AST_REALIGN_PER_FRAME;
}

export class FreeplayNet {
  readonly game: FreeplayGame;
  readonly mode: FreeplayMode;
  /** The sector this session queued for (null in free play). */
  readonly sector: FreeplaySector | null;

  private socket: Socket;
  private active = false;          // join() called and not yet torn down
  private events: FreeplayEvents = {};
  private joined: FreeplayJoinedInfo | null = null;

  /** True from the click until `freeplay:joined` (lobby modes only). Set
   *  OPTIMISTICALLY — never waits for the server to echo anything. */
  private searching = false;
  private queue: FreeplayQueueStatus = { inQueue: false, current: 1, needed: 2 };

  /** Latest `freeplay:match_state` (lobby modes only). */
  private matchState: MatchState | null = null;

  /**
   * THE ZONE RULESET THE SERVER IS RUNNING — the practice difficulty code
   * (10/11/12/13, or 1 for the no-zone free-play world). Stamped on
   * `freeplay:joined` / `freeplay:match_found` / `freeplay:match_state`
   * (SectorStamp), so whichever lands first wins and ordering cannot lose it.
   * Null until the server has told us; the games treat null as "no zone yet".
   */
  private serverDifficulty: number | null = null;
  private serverSector: FreeplaySector | null = null;

  // Snapshot ring buffer, oldest → newest.
  private frames: StateFrame[] = [];

  // Cells food accumulates from {added, removed} deltas keyed by id.
  private foodMap = new Map<string | number, NetFood>();
  private foodArrayCache: NetFood[] = [];
  private foodDirty = false;

  // Bullet headings derived from frame-to-frame motion (server may omit angles).
  private bulletAngles = new Map<string | number, number>();

  // Latest local input, resent every 50ms (last-write-wins on the server too).
  private input: FreeplayInput;
  private inputTimer: ReturnType<typeof setInterval> | null = null;

  // Local prediction state for OUR entity.
  private pred: Prediction | null = null;
  private lastPredictAt = 0;

  /**
   * performance.now() − server tick timestamp, min-filtered.
   *
   * Interpolating on ARRIVAL times makes packet jitter look like speed
   * changes (two snapshots that arrive 20ms apart still describe 50ms of
   * motion). Interpolating on the SERVER's own clock removes that entirely:
   * this offset maps server time into our local timeline. The minimum is the
   * best estimate (it is the sample with the least queueing delay); it is
   * allowed to creep upward slowly so real clock drift is still tracked.
   *
   * `clockOffsetTarget` is the raw min-filtered estimate; `clockOffset` is the
   * rate-limited value the renderer actually uses, so a better estimate eases
   * in over a few frames instead of yanking the playback clock.
   */
  private clockOffsetTarget: number | null = null;
  private clockOffset: number | null = null;

  // If the server never answers a FREE PLAY join (no token, server down,
  // rejected handshake), surface an error instead of hanging on "linking".
  // Queued modes have no timeout — a queue can legitimately take minutes.
  private joinTimeout: ReturnType<typeof setTimeout> | null = null;

  // Bound handlers so we can socket.off() EXACTLY ours (the socket is shared).
  private boundHandlers: Array<[string, (...args: any[]) => void]> = [];

  constructor(
    game: FreeplayGame,
    mode: FreeplayMode = 'free_play',
    sector: FreeplaySector | null = null
  ) {
    this.game = game;
    this.mode = mode;
    // Free play has no sector by construction; a queued mode always carries one.
    this.sector = isQueuedMode(mode) ? sector : null;
    this.socket = getSocket();
    this.input = game === 'cells' ? { dx: 0, dy: 0, boost: false } : { turn: 0, shoot: false, reload: false };
  }

  get joinedInfo(): FreeplayJoinedInfo | null {
    return this.joined;
  }

  /**
   * The practice difficulty code the SERVER is simulating (10/11/12/13, or 1
   * for free play), or null before the server has said. The games read this
   * every frame and render the zone off it exactly as practice does.
   */
  get matchDifficulty(): number | null {
    return this.serverDifficulty;
  }

  /** The sector the server confirmed (null for the permanent world). */
  get matchSector(): FreeplaySector | null {
    return this.serverSector;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** True while we are queued for a lobby match (drives the searching screen). */
  get isSearching(): boolean {
    return this.searching;
  }

  get queueStatus(): FreeplayQueueStatus {
    return this.queue;
  }

  /** Latest match lifecycle snapshot (null in free play / before the first). */
  get matchStatus(): MatchState | null {
    return this.matchState;
  }

  /**
   * Enter the online world. For free play this joins the permanent world
   * immediately; for slayer/lms it enters the matchmaking queue and the
   * caller should show SEARCHING FOR ONLINE MATCH until `onJoined` fires.
   *
   * Emits are buffered by socket.io until the (re)connect completes, so this
   * is safe to call before the socket is up. On reconnect we re-send the join
   * (or re-enter the queue) from the connect handler.
   */
  join(events: FreeplayEvents): void {
    if (this.active) return;
    this.active = true;
    this.events = events;

    // OPTIMISTIC: queued modes are "searching" from this instant, regardless
    // of what (or whether) the server replies.
    if (isQueuedMode(this.mode)) {
      this.searching = true;
      this.queue = { inQueue: true, current: 1, needed: 2 };
      this.events.onQueue?.(this.queue);
    }

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
      // The match exists: the searching screen must come down.
      this.searching = false;
      this.queue = { ...this.queue, inQueue: false };
      this.absorbSectorStamp(payload);
      const info: FreeplayJoinedInfo = {
        ...payload,
        sector: this.serverSector,
        difficulty: this.serverDifficulty ?? undefined,
      };
      this.joined = info;
      this.events.onJoined?.(info);
    });

    // Shared matchmaking queue status (socket/queue.ts). Only ours matters.
    on('queue:status', (p: any) => {
      if (!p || typeof p !== 'object') return;
      if (p.game !== this.game) return;
      if (!this.isOurQueue(p.mode)) return;
      const status: FreeplayQueueStatus = {
        inQueue: !!p.inQueue,
        current: Math.max(0, Number(p.current ?? 0)),
        needed: Math.max(2, Number(p.needed ?? 2)),
        voteOpen: p.voteOpen === true,
        votes: Math.max(0, Number(p.votes ?? 0)),
        votesNeeded: Math.max(0, Number(p.votesNeeded ?? 0)),
      };
      this.queue = status;
      // A server-side dequeue (cancel echo, displaced slot) drops the screen;
      // a match start is signalled by freeplay:joined, never by inQueue:false.
      if (!status.inQueue && !this.joined) this.searching = false;
      this.events.onQueue?.(status);
    });

    on('freeplay:state', (payload: any) => {
      if (!payload || typeof payload !== 'object') return;
      this.pushState(payload);
    });

    on('freeplay:pot', (p: any) => this.events.onPot?.({ pot: Number(p?.pot ?? 0), kills: Number(p?.kills ?? 0) }));
    on('freeplay:kill', (p: any) => this.events.onKill?.({ victimName: String(p?.victimName ?? 'UNKNOWN'), earned: Number(p?.earned ?? 0) }));
    on('freeplay:killed', (p: any) =>
      this.events.onKilled?.({ by: String(p?.by ?? 'UNKNOWN'), potLost: Number(p?.potLost ?? 0), respawnIn: Number(p?.respawnIn ?? 2500) }));
    on('freeplay:respawn', (p: any) => {
      // Respawn teleports us — drop the prediction so we don't drag a stale
      // position across the map before the reconciler catches up.
      this.pred = null;
      this.events.onRespawn?.({ pot: Number(p?.pot ?? p?.respawnPot ?? 0) });
    });
    on('freeplay:eliminated', (p: any) =>
      this.events.onEliminated?.({ reason: String(p?.reason ?? 'eliminated'), potLost: Number(p?.potLost ?? 0) }));
    // ── Match-scoped lifecycle (slayer / lms) ──
    on('freeplay:match_found', (p: any) => {
      // The roster closed: we are definitively out of the queue.
      this.searching = false;
      this.queue = { ...this.queue, inQueue: false };
      this.absorbSectorStamp(p);
      this.events.onMatchFound?.({
        startsIn: Math.max(0, Number(p?.startsIn ?? 0)),
        players: Array.isArray(p?.players)
          ? p.players.map((x: any) => ({ id: String(x?.id ?? ''), name: String(x?.name ?? '?') }))
          : [],
      });
    });

    on('freeplay:match_state', (p: any) => {
      this.absorbSectorStamp(p);
      const status: MatchStatus =
        p?.status === 'waiting' || p?.status === 'ended' ? p.status : 'running';
      this.matchState = {
        status,
        alive: Math.max(0, Number(p?.alive ?? 0)),
        total: Math.max(0, Number(p?.total ?? 0)),
        startsIn: Math.max(0, Number(p?.startsIn ?? 0)),
      };
      this.events.onMatchState?.(this.matchState);
    });

    on('freeplay:match_end', (p: any) => {
      this.absorbSectorStamp(p);
      const myId = this.joined?.playerId ?? null;
      // SLAYER has no winner: the server sends `scoring:'kills'` and
      // `winner:null`, and the client MUST render a ranked kill board instead
      // of a victory/defeat verdict. `mode` is the fallback if an older
      // server omits `scoring`.
      const scoring: MatchScoring =
        p?.scoring === 'kills' || p?.scoring === 'survival'
          ? p.scoring
          : this.mode === 'slayer'
            ? 'kills'
            : 'survival';
      const standings: MatchStanding[] = Array.isArray(p?.standings)
        ? p.standings.map((s: any) => {
            const kills = Number(s?.kills ?? 0);
            const score = Number(s?.score ?? 0);
            const id = String(s?.id ?? '');
            return {
              id,
              name: String(s?.name ?? '?'),
              kills,
              score,
              points: Number(s?.points ?? (scoring === 'kills' ? kills : score)),
              place: Number(s?.place ?? 0),
              alive: !!s?.alive,
              isYou: myId !== null && id === myId,
            };
          })
        : [];
      const winnerId = p?.winner?.id !== undefined && p?.winner?.id !== null ? String(p.winner.id) : null;
      const mine = myId ? standings.find((s) => s.id === myId) ?? null : null;
      this.events.onMatchEnd?.({
        // Never "won" in slayer, whatever else the payload says.
        won: scoring !== 'kills' && myId !== null && winnerId !== null && winnerId === myId,
        winnerName: scoring === 'kills' ? null : p?.winner?.name ? String(p.winner.name) : null,
        reason: String(p?.reason ?? 'last_standing'),
        standings,
        place: mine ? mine.place : null,
        scoring,
        kills: mine ? mine.kills : 0,
      });
    });
    on('freeplay:cashout_confirmed', (p: any) =>
      this.events.onCashoutConfirmed?.({ payout: Number(p?.payout ?? 0), kills: Number(p?.kills ?? 0) }));
    on('freeplay:error', (p: any) =>
      this.events.onError?.({ code: String(p?.code ?? 'unknown'), message: p?.message ? String(p.message) : undefined }));

    // Shared refusal for "no registered account" (queue + world both send it).
    // Without this the player would sit on the searching screen with no reason.
    on('gameAuthError', (p: any) => {
      this.searching = false;
      this.events.onError?.({
        code: String(p?.code ?? 'no_account'),
        message: p?.message ? String(p.message) : 'Finish account setup to play online',
      });
    });

    // Re-join / re-queue on every (re)connect while the session is live — the
    // server's disconnect grace turns this into a seamless resume.
    on('connect', () => {
      if (this.active) this.sendEntry();
    });

    connectGameSocket();
    if (this.socket.connected) {
      // Already connected: the 'connect' handler above won't fire, emit now.
      this.sendEntry();
    }

    // 20Hz input pump. The server treats inputs as last-write-wins per tick,
    // so re-sending an unchanged input every 50ms is the simplest correct thing.
    this.inputTimer = setInterval(() => {
      if (this.active && this.socket.connected && !this.searching) {
        this.socket.emit('freeplay:input', this.input);
      }
    }, INPUT_INTERVAL_MS);

    // Join watchdog — FREE PLAY ONLY. No `freeplay:joined` within 8s means we
    // never reached the world (missing token, rejected handshake, server down).
    // Queued modes must never time out: waiting IS the expected state.
    if (!isQueuedMode(this.mode)) {
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
  }

  /**
   * Absorb the SectorStamp the server puts on every lobby payload
   * (`freeplay:joined` / `match_found` / `match_state` / `match_end`):
   * `{ sector, difficulty }`. First non-null wins per field, so a payload
   * that omits the stamp can never blank a difficulty we already know.
   */
  private absorbSectorStamp(p: any): void {
    if (!p || typeof p !== 'object') return;
    if (typeof p.difficulty === 'number' && Number.isFinite(p.difficulty)) {
      this.serverDifficulty = p.difficulty;
    }
    if (p.sector === 'eclipse' || p.sector === 'blitz') {
      this.serverSector = p.sector;
    }
  }

  /**
   * Is this `queue:status` about OUR queue? The server keys the four
   * sector×mode queues as `eclipse:slayer` … `blitz:lms`, so the wire `mode`
   * is the queue key, not the bare mode. Bare modes are still accepted (older
   * server / single-queue games).
   */
  private isOurQueue(wireMode: unknown): boolean {
    if (typeof wireMode !== 'string' || wireMode.length === 0) return true;
    const idx = wireMode.indexOf(':');
    const sector = idx >= 0 ? wireMode.slice(0, idx) : null;
    const mode = idx >= 0 ? wireMode.slice(idx + 1) : wireMode;
    if (mode !== this.mode) return false;
    if (sector !== null && this.sector !== null && sector !== this.sector) return false;
    return true;
  }

  /** Emit the mode-appropriate entry event (join vs queue). Idempotent. */
  private sendEntry(): void {
    if (isQueuedMode(this.mode)) {
      // The server ALWAYS answers `find` with queue:status, duplicates
      // included. `sector` is REQUIRED on this path — (sector, mode) is what
      // the server turns into the difficulty code the zone runs on.
      this.socket.emit('freeplay:find', {
        game: this.game,
        mode: this.mode,
        ...(this.sector ? { sector: this.sector } : {}),
      });
    } else {
      this.socket.emit('freeplay:join', { game: this.game, mode: this.mode });
    }
  }

  /** The `freeplay:cancel` payload — sector included so only OUR queue drops. */
  private cancelPayload(): { game: FreeplayGame; mode: FreeplayMode; sector?: FreeplaySector } {
    return {
      game: this.game,
      mode: this.mode,
      ...(this.sector ? { sector: this.sector } : {}),
    };
  }

  /** Merge new values into the input snapshot sent by the 20Hz pump. */
  setInput(partial: Partial<FreeplayInput>): void {
    this.input = { ...this.input, ...partial } as FreeplayInput;
  }

  /** Player pressed the hold-to-cashout button. Unused this pass (no money). */
  startCashout(): void {
    if (this.active) this.socket.emit('freeplay:cashout_start');
  }

  /** Player released early — server aborts the hold. Unused this pass. */
  cancelCashout(): void {
    if (this.active) this.socket.emit('freeplay:cashout_cancel');
  }

  /**
   * Cancel matchmaking (CANCEL button / unmount / view change). Always emits,
   * even if we think we are not queued — a leaked server-side slot is exactly
   * what made re-searching fail before.
   */
  /** Cast this player's FFA early-start vote (fill-first queues). */
  voteStart(): void {
    const socket = this.socket;
    if (!socket?.connected) return;
    // The queue key is the `${sector}:${mode}` composite (freeplay/lobby.ts).
    const wireMode = this.sector ? `${this.sector}:${this.mode}` : this.mode;
    socket.emit('queue:voteStart', { game: this.game, mode: wireMode });
  }

  cancel(): void {
    if (this.socket.connected) {
      this.socket.emit('freeplay:cancel', this.cancelPayload());
    }
    this.searching = false;
    this.dispose();
  }

  /**
   * Voluntary exit. While queued this cancels matchmaking; in a live world it
   * despawns us server-side. Use dispose() instead when the session already
   * ended server-side (eliminated / match over) to avoid a pointless emit.
   */
  leave(): void {
    if (this.searching && !this.joined) {
      this.cancel();
      return;
    }
    if (this.active && this.socket.connected) {
      this.socket.emit('freeplay:leave');
      // Belt and braces: if we were still holding a queue slot (e.g. the match
      // start raced our exit) drop it too. Harmless when not queued.
      if (isQueuedMode(this.mode)) {
        this.socket.emit('freeplay:cancel', this.cancelPayload());
      }
    }
    this.dispose();
  }

  /** Tear down listeners/timers WITHOUT emitting anything. Idempotent. */
  dispose(): void {
    this.active = false;
    this.searching = false;
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
    this.frames = [];
    this.pred = null;
    this.clockOffset = null;
    this.clockOffsetTarget = null;
    this.matchState = null;
    this.serverDifficulty = null;
    this.serverSector = null;
    this.foodMap.clear();
    this.foodArrayCache = [];
    this.bulletAngles.clear();
    // NOTE: never disconnect the shared socket here — other games use it.
  }

  /** Ingest one `freeplay:state` frame: push the ring buffer, apply food deltas. */
  private pushState(payload: any): void {
    const frame: StateFrame = {
      t: Number(payload.t ?? 0),
      recvAt: performance.now(),
      you: payload.you && typeof payload.you === 'object' ? (payload.you as NetEntity) : null,
      players: Array.isArray(payload.players) ? (payload.players as NetEntity[]) : [],
      asteroids: Array.isArray(payload.asteroids) ? (payload.asteroids as NetEntity[]) : [],
      bullets: Array.isArray(payload.bullets) ? (payload.bullets as NetBullet[]) : [],
      leaderboard: Array.isArray(payload.leaderboard)
        ? payload.leaderboard.map((l: any) => {
            // Server may send {name, pot} (legacy money world) or
            // {name, kills|score}. Kills/score is what the HUD shows now.
            const kills = Number(l?.kills ?? 0);
            const score = Number(l?.score ?? l?.kills ?? l?.mass ?? 0);
            return { name: String(l?.name ?? '?'), score, kills, pot: Number(l?.pot ?? 0) };
          })
        : [],
      // Server-authoritative safe zone (see the marked block above).
      zone: parseNetZone(payload),
    };

    // Some snapshots restamp the ruleset; absorbing it here means a client
    // that joined before the stamp existed still learns the difficulty.
    this.absorbSectorStamp(payload);

    const prev = this.frames[this.frames.length - 1];
    this.frames.push(frame);
    if (this.frames.length > MAX_FRAMES) this.frames.shift();

    // Track the server↔client clock offset (see the field's comment).
    if (frame.t > 0) {
      const sample = frame.recvAt - frame.t;
      this.clockOffsetTarget =
        this.clockOffsetTarget === null
          ? sample
          : Math.min(sample, this.clockOffsetTarget + CLOCK_DRIFT_PER_FRAME);
    }

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
      if (prev) {
        for (const b of prev.bullets) {
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

  /** ONE practice frame (1/60s) of the local player's motion — the exact
   *  integration the server runs, so the two stay in lockstep. */
  private predictFrame(p: Prediction): void {
    if (this.game === 'cells') {
      const input = this.input as CellsInput;
      const len = Math.hypot(input.dx ?? 0, input.dy ?? 0);
      if (len > CELLS_DEADZONE) {
        // Direction only — a diagonal must not be √2 faster.
        const nx = (input.dx ?? 0) / len;
        const ny = (input.dy ?? 0) / len;
        // Boost only counts when the server-side bank is non-empty
        // (p.boostOk mirrors you.boostRemaining) — predicting a x1.65 the
        // server refuses ran the client hot and rubber-banded it back.
        const accel =
          (CELLS_ACCEL_NUM / Math.sqrt(Math.max(1, p.r))) *
          (input.boost && p.boostOk !== false ? CELLS_BOOST_MULT : 1);
        p.vx += nx * accel;
        p.vy += ny * accel;
      }
      p.vx *= CELLS_VEL_DECAY;
      p.vy *= CELLS_VEL_DECAY;
      p.x += p.vx * FRAME_DT;
      p.y += p.vy * FRAME_DT;
      this.clampToWorld(p);
    } else {
      const input = this.input as AsteroidsInput;
      const turn = input.turn ?? 0;
      if (turn !== 0) {
        p.av += turn * AST_TURN_ACCEL_PER_FRAME;
      } else {
        p.av += realignDelta(p.angle);
      }
      p.av = Math.max(-AST_MAX_TURN_RATE, Math.min(AST_MAX_TURN_RATE, p.av));
      p.angle += p.av * FRAME_DT;
      p.av *= AST_ANG_FRICTION;

      // Auto-drive: constant forward thrust, then friction.
      p.vx += Math.cos(p.angle) * AST_THRUST_PER_FRAME;
      p.vy += Math.sin(p.angle) * AST_THRUST_PER_FRAME;
      p.x += p.vx * FRAME_DT;
      p.y += p.vy * FRAME_DT;
      p.vx *= AST_VEL_FRICTION;
      p.vy *= AST_VEL_FRICTION;
      this.clampToWorld(p);
    }
  }

  /** The server bounces off the world edge at half speed
   *  (cellsWorld/asteroidsWorld) — without mirroring it, prediction sails
   *  past the wall and the reconciler drags it back in a visible smear.
   *  ‼️ Uses the server's OWN bounds from freeplay:joined: cells is
   *  origin-centred (-3000..3000) while asteroids is zero-based — assuming
   *  [0,w]x[0,h] here once built an invisible wall through half the cells
   *  map. No bounds in the payload = no clamping at all. */
  private clampToWorld(p: Prediction): void {
    const b = this.joined?.world?.bounds;
    if (!b) return;
    const r = Math.max(0, p.r);
    if (p.x < b.minX + r) {
      p.x = b.minX + r;
      if (p.vx < 0) p.vx *= -0.5;
    } else if (p.x > b.maxX - r) {
      p.x = b.maxX - r;
      if (p.vx > 0) p.vx *= -0.5;
    }
    if (p.y < b.minY + r) {
      p.y = b.minY + r;
      if (p.vy < 0) p.vy *= -0.5;
    } else if (p.y > b.maxY - r) {
      p.y = b.maxY - r;
      if (p.vy > 0) p.vy *= -0.5;
    }
  }

  /**
   * Advance the local prediction by `dt` seconds and bleed off the error
   * against the newest server truth.
   *
   * WHY: the local player is camera-locked, so ANY snapshot jitter on it shows
   * up as the whole world shaking. Re-running the server's own simulation from
   * our own input gives a perfectly smooth, input-latency-free cell/ship; the
   * server stays authoritative because every frame pulls us back toward its
   * position, and a big divergence (respawn, kill, wall) snaps outright.
   */
  private predictSelf(latestYou: NetEntity, dt: number, snapshotAgeSec = 0): NetEntity {
    const serverR = Number(latestYou.r ?? latestYou.radius ?? 0);
    const serverAngle = Number(latestYou.angle ?? 0);
    const serverVx = Number(latestYou.vx ?? 0);
    const serverVy = Number(latestYou.vy ?? 0);
    // Reconcile toward the snapshot EXTRAPOLATED to render time using its
    // own velocity — the raw snapshot is (half-RTT + up to one tick) stale
    // and only steps at 20Hz, so pulling toward it every frame both erased
    // the prediction's latency win (~100-150ms of felt input lag) and
    // rippled at 20Hz. Clamped so a hiccup cannot fling the target.
    const targetX = latestYou.x + serverVx * snapshotAgeSec;
    const targetY = latestYou.y + serverVy * snapshotAgeSec;

    if (!this.pred) {
      this.pred = {
        x: latestYou.x,
        y: latestYou.y,
        vx: serverVx,
        vy: serverVy,
        angle: serverAngle,
        av: 0,
        r: serverR,
        accum: 0,
      };
    }
    const p = this.pred;

    // Fixed-step integration, exactly like the server's substeps.
    if (dt > 0) {
      p.accum += dt;
      let frames = 0;
      while (p.accum >= FRAME_DT && frames < MAX_PREDICT_FRAMES) {
        this.predictFrame(p);
        p.accum -= FRAME_DT;
        frames++;
      }
      if (p.accum > FRAME_DT) p.accum = 0; // came back from a background tab
    }

    // Cells: mirror the server's boost bank into the next predictFrame runs.
    p.boostOk = Number((latestYou as { boostRemaining?: number }).boostRemaining ?? 1) > 0;

    // ── Reconcile against the newest server truth ──
    const err = Math.hypot(targetX - p.x, targetY - p.y);
    if (err > SNAP_DIST) {
      // Teleport (respawn, kill, wall clamp, big desync): take the server's word.
      p.x = latestYou.x;
      p.y = latestYou.y;
      p.vx = serverVx;
      p.vy = serverVy;
      p.angle = serverAngle;
      p.av = 0;
    } else if (dt > 0) {
      const k = 1 - Math.exp(-RECONCILE_RATE * dt);
      p.x = lerp(p.x, targetX, k);
      p.y = lerp(p.y, targetY, k);
      // Velocity too, so a wall bounce or a collision we didn't simulate
      // doesn't leave us fighting the server for the next second.
      p.vx = lerp(p.vx, serverVx, k);
      p.vy = lerp(p.vy, serverVy, k);
      if (this.game === 'asteroids' && latestYou.angle !== undefined) {
        p.angle = lerpAngle(p.angle, serverAngle, k);
      }
    }

    // Size is server-owned but smoothed so eating never pops a frame.
    if (serverR > 0) {
      const kr = dt > 0 ? 1 - Math.exp(-RADIUS_RATE * dt) : 1;
      p.r = p.r > 0 ? lerp(p.r, serverR, kr) : serverR;
    }

    // Base on the NEWEST server entity so HUD fields (hp, ammo, kills) are
    // never delayed — only the pose comes from prediction. The pose includes
    // the SUB-FRAME remainder (p.accum, 0..16.6ms): whole-quantum output
    // made render frames alternately consume 0 or 2 physics steps, and with
    // the camera locked to this entity every such frame lurched the entire
    // world by one physics frame of motion.
    const out: NetEntity = {
      ...latestYou,
      x: p.x + p.vx * p.accum,
      y: p.y + p.vy * p.accum,
    };
    if (p.r > 0) out.r = p.r;
    if (this.game === 'asteroids') out.angle = p.angle + p.av * p.accum;
    return out;
  }

  /**
   * Produce render-ready entities for `nowMs` (performance.now() basis).
   *
   * Remote entities are rendered RENDER_DELAY_MS behind the newest snapshot on
   * a MONOTONIC clock: we look up the two buffered frames that bracket
   * `now - RENDER_DELAY_MS` and lerp between them. Because the playback time
   * only ever moves forward with the wall clock, arrival jitter can no longer
   * push the interpolation backwards (the old two-frame implementation flipped
   * its time basis whenever the buffer ran short — that was the visible jitter).
   *
   * The LOCAL player is predicted instead (see predictSelf).
   * Returns null until the first state arrives.
   */
  interpolate(nowMs: number): InterpolatedWorld | null {
    const n = this.frames.length;
    if (n === 0) return null;

    const latest = this.frames[n - 1];

    // Real elapsed time since the last render (also used by the predictor).
    const rawDt = this.lastPredictAt > 0 ? Math.min(0.1, Math.max(0, (nowMs - this.lastPredictAt) / 1000)) : 0;

    // ── slew the render clock toward the newest offset estimate ──
    // Applying a better (smaller) offset instantly would yank the playback
    // clock forward and show up as one hitched frame. Easing it at a bounded
    // rate keeps the clock monotonic and the correction invisible.
    if (this.clockOffsetTarget !== null) {
      if (this.clockOffset === null) {
        this.clockOffset = this.clockOffsetTarget;
      } else {
        const diff = this.clockOffsetTarget - this.clockOffset;
        const maxStep = OFFSET_SLEW * rawDt * 1000;
        this.clockOffset += Math.max(-maxStep, Math.min(maxStep, diff));
      }
    }

    // ── pick the bracketing pair for the delayed render time ──
    // Basis: the SERVER's tick clock when it is usable (jitter-free spacing),
    // otherwise our arrival times. `timeOf` keeps the rest of the maths
    // identical either way.
    const useServerClock =
      this.clockOffset !== null && latest.t > 0 && this.frames[0].t > 0 && this.frames[0].t !== latest.t;
    const timeOf = (f: StateFrame) => (useServerClock ? f.t : f.recvAt);
    const renderTime = useServerClock
      ? nowMs - (this.clockOffset as number) - RENDER_DELAY_MS
      : nowMs - RENDER_DELAY_MS;

    let prev: StateFrame = this.frames[0];
    let next: StateFrame = latest;
    if (renderTime >= timeOf(latest)) {
      // Buffer ran dry (late packets): hold the newest frame — never extrapolate.
      prev = latest;
      next = latest;
    } else {
      for (let i = n - 1; i > 0; i--) {
        if (timeOf(this.frames[i - 1]) <= renderTime) {
          prev = this.frames[i - 1];
          next = this.frames[i];
          break;
        }
      }
    }
    const span = timeOf(next) - timeOf(prev);
    const alpha = span > 0 ? Math.max(0, Math.min(1, (renderTime - timeOf(prev)) / span)) : 1;

    // Index the previous frame's entities by id for pairing.
    const prevPlayers = new Map<string, NetEntity>();
    const prevAsteroids = new Map<string | number, NetEntity>();
    const prevBullets = new Map<string | number, NetBullet>();
    for (const p of prev.players) prevPlayers.set(p.id, p);
    for (const a of prev.asteroids) if (a.id !== undefined) prevAsteroids.set(a.id, a);
    for (const b of prev.bullets) if (b.id !== undefined) prevBullets.set(b.id, b);

    const myId = this.joined?.playerId;

    // ── Own state: LOCAL PREDICTION (not interpolation) ──
    // A lobby match is FROZEN during its start countdown (and after it ends):
    // the server broadcasts states but does not step the sim, so predicting
    // through those phases would fly the ship away and snap it back every
    // snapshot. dt = 0 means "hold exactly what the server says".
    const simRunning = this.matchState === null || this.matchState.status === 'running';
    // A dead body is not simulated either — it waits for the respawn.
    const selfAlive = latest.you?.alive !== false;
    const dt = simRunning && selfAlive ? rawDt : 0;
    this.lastPredictAt = nowMs;
    let you: NetEntity | null = null;
    if (latest.you) {
      const age =
        this.clockOffset !== null && latest.t > 0
          ? Math.min(0.25, Math.max(0, (nowMs - this.clockOffset - latest.t) / 1000))
          : 0;
      you = this.predictSelf(latest.you, dt, age);
    } else {
      this.pred = null; // dead / despawned — restart prediction on respawn
    }

    // Other players (defensively drop self if the server includes us in the list).
    const players: NetEntity[] = [];
    for (const p of next.players) {
      if (myId !== undefined && p.id === myId) continue;
      players.push(lerpEntity(prevPlayers.get(p.id), p, alpha));
    }

    const asteroids = next.asteroids.map((a) =>
      a.id !== undefined ? lerpEntity(prevAsteroids.get(a.id), a, alpha) : a
    );

    const bullets: NetBullet[] = next.bullets.map((b) => {
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

    // Zone: interpolated exactly like everything else remote, so a ring that
    // shrinks at 20Hz still draws smoothly. Pure server truth — no local sim.
    const zone = next.zone ? lerpZone(prev.zone, next.zone, alpha) : latest.zone;

    return {
      you,
      players,
      asteroids,
      bullets,
      food: this.foodArrayCache,
      leaderboard: latest.leaderboard,
      zone,
    };
  }
}
