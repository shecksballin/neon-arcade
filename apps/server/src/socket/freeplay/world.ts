/**
 * WORLD BASE CLASS — one simulation engine, three online modes
 * ============================================================
 * A World is a 20 Hz authoritative simulation of one game (cells /
 * asteroids). The SAME engine runs all three online modes — the mode only
 * changes the lifecycle and the death rule:
 *
 *   free_play (permanent)  status is 'running' from construction to process
 *                          exit; deaths respawn after RESPAWN_DELAY_MS; the
 *                          (best-effort) pot ledger applies.
 *   slayer / lms (lobby) match-scoped: waiting → running → ended.
 *                          Deaths are ELIMINATIONS (no respawn, no bots),
 *                          the match ends at last man standing, and NO
 *                          money is touched at all.
 *
 * WIN CONDITIONS (contract, load-bearing):
 *   lms     last player alive WINS. `winner` is that player; stats write a
 *           win row for them and a loss row for everyone else.
 *   slayer  NO WINNER AND NO LOSER. `winner` is always null, every player is
 *           ranked by the kills they scored (their "points"), and stats write
 *           result 'none' — so slayer feeds K/D but never win rate.
 *
 * RANKED 2.0 (rankingLogic.md): slayer and lms settle on the shared 'ffa'
 * rating ladder when the match ends — LMS ordered by finishing placement,
 * SLAYER by kill count (ties stay ties). See settleRanked() for the ordering
 * argument, including the judgement call slayer required. FREE PLAY IS
 * UNRANKED and must stay that way: it has no outcome, so nothing in here may
 * move skill or RP for it.
 *
 * SECTORS / ZONES: a lobby world carries a practice DIFFICULTY CODE
 * (10 eclipse+slayer, 11 eclipse+lms, 12 blitz+slayer, 13 blitz+lms; 1 for
 * the permanent free world = no zone). It is derived server-side from
 * (sector, mode), exposed to the subclasses as `this.difficulty` plus the
 * `zoneEnabled` / `isBlitz` / `isFastShrink` / `elapsedMs()` hooks, and
 * stamped onto every lobby payload so clients render the matching zone.
 *
 * MONEY IS NEVER A GATE (contract "NO WAGER / NO MONEY"): every wagerService
 * call is best-effort. No database, a failed pot call, or a stranded
 * 'already_active' row all fall back to a purely in-memory session and play
 * continues. `session.kills` / `session.score` are authoritative in memory
 * (they drive scoring); only `session.pot` is a cache of the ledger.
 *
 * Game rules (movement, collisions, food, bullets) live in the subclasses
 * via the abstract hooks at the bottom. Subclasses integrate their physics
 * in fixed 1/60 s sub-steps so practice-mode constants transfer verbatim.
 */

import { randomUUID } from 'node:crypto'
import type { Socket } from 'socket.io'
import {
  cashOut,
  getActivePlayerRow,
  joinFreeplay,
  onEnvironmentKill,
  onKill,
} from '../../services/wagerService'
// RANK (Ranked 2.0 — rankingLogic.md, and the binding contract's "Which
// results feed the ranking"):
//
//   FREE PLAY IS UNRANKED. The permanent world used to call
//   eloService.freeplayKill on every PVP kill, moving users.eloFfa. That is
//   gone and must not come back: skill updates come from a MATCH OUTCOME
//   only (§2.2), and free play has no match, no end and no outcome — rating
//   it means the ladder can be farmed forever in a mode nobody can lose.
//   LMS    → N-way settle ordered by finishing PLACEMENT (1 = last standing).
//   SLAYER → N-way settle ordered by KILL COUNT (ties share a placement).
//            Slayer still shows NO WINNER on the results screen; the ordering
//            exists only to feed the rating model. ⚠️ judgement call, flagged.
import { settleRankedFfa, type RankedStanding } from '../../services/rankService'
import { publicRating, type PublicRating } from '../../services/eloService'
// STATS (design contract "STATS RULES" + "STATS IMPACT"):
//   free play  → kills/deaths ONLY, never a win/loss row. `FREEPLAY_MODE` is
//                THE marker every win-rate query excludes, so free-play rows
//                must use that exact string (not the world's 'free_play').
//   slayer     → NO WINNER, so no win/loss either: result 'none' with
//                kills/deaths/score. Feeds K/D, never win rate.
//   lms        → a real win condition: win/loss + kills/deaths + placement.
import {
  FREEPLAY_MODE,
  NO_RESULT,
  recordResult,
  recordResults,
  type MatchOutcome,
  type RecordResultInput,
} from '../../services/statsService'
import {
  CASHOUT_HOLD_MS,
  CASHOUT_HOLD_PENALTY,
  DISCONNECT_GRACE_MS,
  LEADERBOARD_SIZE,
  LOBBY_MAX_PLAYERS,
  MATCH_COUNTDOWN_MS,
  MATCH_END_LINGER_MS,
  MATCH_MAX_DURATION_MS,
  MAX_PLAYERS_PER_WORLD,
  RESPAWN_DELAY_MS,
  FREE_PLAY_DIFFICULTY,
  TICK_MS,
  TICK_RATE,
  emitFreeplayError,
  isBlitzDifficulty,
  isFastShrinkDifficulty,
  isLobbyMode,
  hasZone,
  type BaseSession,
  type FreeplayGame,
  type FreeplayMode,
  type FreeplaySector,
  type JoinedPayload,
  type LeaderboardEntry,
  type MatchEndPayload,
  type MatchFoundPayload,
  type MatchStatePayload,
  type StandingEntry,
  type WorldBounds,
  type WorldStatus,
} from './types'

/**
 * The generic-free public surface of a world. index.ts / lobby.ts route
 * sockets to worlds through this interface so one Map can hold CellsWorld
 * and AsteroidsWorld side by side without generic-variance gymnastics.
 */
export interface FreeplayWorld {
  readonly game: FreeplayGame
  readonly mode: FreeplayMode
  /** eclipse/blitz for a lobby match, null for the permanent free world. */
  readonly sector: FreeplaySector | null
  /** Practice difficulty code (1 = free play, 10/11/12/13 = the 2×2). THE
   *  key the zone simulation reads. */
  readonly difficulty: number
  readonly matchId: string
  readonly status: WorldStatus
  /** Humans currently attached to the world (never includes bots — there
   *  are none, in any mode). */
  readonly playerCount: number
  join(socket: Socket): Promise<void>
  handleInput(socketId: string, raw: unknown): void
  handleCashoutStart(socketId: string): void
  handleCashoutCancel(socketId: string): void
  handleLeave(socketId: string): void
  handleDisconnect(socketId: string): void
  /** Lobby only: close the roster and start the countdown to 'running'. */
  beginMatch(): void
  shutdown(): Promise<void>
}

/** Everything a world needs that is not baked into the game subclass. */
export interface WorldOptions {
  /** Which of the three modes this world serves. */
  mode: FreeplayMode
  /**
   * Which sector a lobby match runs in. Omit/null for the permanent
   * free-play world (no sector, no zone).
   */
  sector?: FreeplaySector | null
  /**
   * PRACTICE DIFFICULTY CODE for this world — derived SERVER-SIDE from
   * (sector, mode) via `difficultyFor()`; never taken from a client.
   * Defaults to FREE_PLAY_DIFFICULTY (1 = INFINITE, no zone).
   */
  difficulty?: number
  /** Public match id — appears in every payload. */
  matchId: string
  /** matches-row id when a ledger exists, null = in-memory only (no DB, or
   *  a lobby match, which never touches money). */
  ledgerMatchId: string | null
  /** Entry-fee snapshot for the pot cache. 0 when there is no ledger. */
  entryFee: number
  /** Shared socket.id → world registry owned by index.ts. */
  bindings: Map<string, FreeplayWorld>
  /** Lobby only: fired once the match is over and the world can be dropped. */
  onEnded?: (world: FreeplayWorld) => void
}

export abstract class World<TInput, TSession extends BaseSession<TInput>>
  implements FreeplayWorld
{
  /** wallet → session. Wallet-keyed because reconnect = same wallet. */
  protected readonly sessions = new Map<string, TSession>()

  /** socket.id → session, for O(1) event routing. */
  private readonly bySocket = new Map<string, TSession>()

  /** Wallets with a join in flight (guards the async gap in join()). */
  private readonly joining = new Set<string>()

  /** Top-N scoreboard, rebuilt each tick, read by subclasses in buildState. */
  protected leaderboard: LeaderboardEntry[] = []

  /** Round-robin cursor for the slow background pot reconcile. */
  private reconcileQueue: string[] = []

  /**
   * session.id → deaths this session has taken (STATS ONLY — nothing in the
   * simulation reads it). It lives here rather than on BaseSession so the
   * session shape the games share stays untouched. Keyed by the session's
   * opaque id, dropped on despawn, and discarded wholesale with the world.
   */
  private readonly deathsBySession = new Map<string, number>()

  public readonly mode: FreeplayMode
  public readonly matchId: string
  /** eclipse/blitz for a lobby match, null for the permanent world. */
  public readonly sector: FreeplaySector | null
  /**
   * THE ZONE KEY. The practice difficulty code this world simulates:
   *   1  free play / practice INFINITE — no zone at all
   *   10 eclipse+slayer   11 eclipse+lms   12 blitz+slayer   13 blitz+lms
   * Subclasses (cellsWorld / asteroidsWorld) read this to run the SAME zone
   * rules practice runs, and it is shipped to clients in every lobby payload
   * so the renderer cannot disagree with the sim.
   */
  public readonly difficulty: number
  /** Wall-clock construction time — the zone clock for the permanent world. */
  public readonly createdAt = Date.now()
  /** True for slayer/lms (match-scoped), false for the permanent world. */
  public readonly isLobby: boolean

  private _status: WorldStatus
  /** Lobby: when the countdown flips 'waiting' → 'running'. */
  private startAt: number | null = null
  /** Lobby: hard stop so a stalemate can't pin a world forever. */
  private deadline: number | null = null
  private ended = false

  private readonly ledgerMatchId: string | null
  private readonly onEnded?: (world: FreeplayWorld) => void

  private tickCount = 0
  private shuttingDown = false
  private interval: ReturnType<typeof setInterval> | null

  protected readonly entryFee: number
  private readonly bindings: Map<string, FreeplayWorld>

  constructor(
    public readonly game: FreeplayGame,
    /** World geometry, shipped to clients in freeplay:joined. */
    protected readonly bounds: WorldBounds,
    /** Interest-management radius — each game sizes it to what its practice
     *  camera can show at maximum zoom-out (otherwise entities pop in
     *  on-screen). */
    protected readonly viewRadius: number,
    options: WorldOptions
  ) {
    this.entryFee = options.entryFee
    this.bindings = options.bindings
    this.mode = options.mode
    this.matchId = options.matchId
    this.ledgerMatchId = options.ledgerMatchId
    this.onEnded = options.onEnded
    this.isLobby = isLobbyMode(options.mode)
    this.sector = options.sector ?? null
    // Defaulted (not required) so a world built without a sector — the
    // permanent free world — is INFINITE/no-zone rather than a type error.
    this.difficulty = options.difficulty ?? FREE_PLAY_DIFFICULTY
    // The permanent world is live from construction; a lobby world waits
    // for its roster and its countdown.
    this._status = this.isLobby ? 'waiting' : 'running'

    // THE loop. For the permanent world it never stops (an empty world just
    // early-exits each tick); a lobby world clears it when the match ends.
    this.interval = setInterval(() => this.tick(), TICK_MS)
  }

  get status(): WorldStatus {
    return this._status
  }

  get playerCount(): number {
    return this.sessions.size
  }

  /** Money bookkeeping is only attempted for the permanent world AND only
   *  when a matches row actually exists. Everything else plays ledger-free. */
  private get hasLedger(): boolean {
    return !this.isLobby && this.ledgerMatchId !== null
  }

  // ────────────────────────────────────────────────
  // ZONE HOOKS — everything a game subclass needs to run practice's zone
  // rules for THIS world, keyed off the difficulty code. (The zone
  // simulation itself lives in cellsWorld.ts / asteroidsWorld.ts.)
  // ────────────────────────────────────────────────

  /** Practice: `difficulty >= 10` enables the shrinking safe zone. */
  protected get zoneEnabled(): boolean {
    return hasZone(this.difficulty)
  }

  /** Practice: difficulty 12|13 → the BLITZ shrink rate / phase timings. */
  protected get isBlitz(): boolean {
    return isBlitzDifficulty(this.difficulty)
  }

  /** Practice: difficulty 11|13 → the faster-shrink (LMS) branch. */
  protected get isFastShrink(): boolean {
    return isFastShrinkDifficulty(this.difficulty)
  }

  /**
   * The instant this world's simulation starts/started running — the origin
   * for every zone phase timer. Lobby: the moment the countdown ends (set by
   * beginMatch, so it is stable across ticks). Permanent world: construction.
   */
  protected get simStartAt(): number {
    return this.startAt ?? this.createdAt
  }

  /** ms of RUNNING simulation so far (0 during a lobby countdown). */
  protected elapsedMs(now: number): number {
    return Math.max(0, now - this.simStartAt)
  }

  /** The sector/difficulty stamp every lobby payload (and every snapshot)
   *  carries so the client renders the right zone. */
  protected sectorStamp(): { sector: FreeplaySector | null; difficulty: number } {
    return { sector: this.sector, difficulty: this.difficulty }
  }

  // ────────────────────────────────────────────────
  // Join / resume (async — runs OUTSIDE the tick loop)
  // ────────────────────────────────────────────────

  async join(socket: Socket): Promise<void> {
    // Trusted identity only — set by the handshake auth middleware.
    const wallet = socket.data.wallet as string
    // index.ts already refused unregistered accounts; fallback is defensive.
    const name = (socket.data.username as string | null) ?? 'Player'

    // The match is over: answer with the result instead of a dead session,
    // so a client that mounted late still gets its scoreboard.
    if (this._status === 'ended') {
      socket.emit('freeplay:match_end', this.buildMatchEnd('last_standing'))
      return
    }

    // RESUME: same wallet joining again = reconnect or a tab switch. Rebind
    // the socket to the existing session — same public id, same body.
    const existing = this.sessions.get(wallet)
    if (existing) {
      this.resume(existing, socket)
      return
    }

    if (this.joining.has(wallet)) {
      emitFreeplayError(socket, 'join_failed', 'Join already in progress')
      return
    }
    if (this.shuttingDown) {
      emitFreeplayError(socket, 'join_failed', 'Server is restarting — try again shortly')
      return
    }
    // A match-scoped world only ever admits the roster the queue handed
    // over, and only before the first simulated tick. No walk-ins, no bots.
    if (this.isLobby && this._status !== 'waiting') {
      emitFreeplayError(socket, 'join_failed', 'That match has already started')
      return
    }
    const cap = this.isLobby ? LOBBY_MAX_PLAYERS : MAX_PLAYERS_PER_WORLD
    if (this.sessions.size >= cap) {
      emitFreeplayError(socket, 'world_full', 'This world is full — try again soon')
      return
    }

    this.joining.add(wallet)
    try {
      // Build the session FIRST — the simulation never waits on the ledger.
      const session = this.newSession(randomUUID(), wallet, name, socket)
      session.pot = this.entryFee
      this.spawn(session) // game-specific position + fields
      session.alive = true
      this.sessions.set(wallet, session)

      if (socket.connected) {
        this.bySocket.set(socket.id, session)
        this.bindings.set(socket.id, this)
      } else {
        // The socket died before we could bind it. Enter the session in
        // grace mode so the lifecycle scan (permanent) / the connected-count
        // check (lobby) reclaims it instead of leaking a body forever.
        session.socket = null
        session.disconnectedAt = Date.now()
      }

      this.emitJoined(session)

      // Pot bookkeeping is BEST EFFORT and strictly after the fact: a
      // missing DB, a DB error or a stranded 'already_active' row all leave
      // the session playing with a local-only pot cache.
      if (this.hasLedger) void this.attachLedger(session)
    } catch (err) {
      // Never let a join explosion take down the caller.
      console.error(`[freeplay:${this.game}/${this.mode}] join failed:`, err)
      emitFreeplayError(socket, 'join_failed', 'Join failed — try again')
    } finally {
      this.joining.delete(wallet)
    }
  }

  /**
   * Try to back an already-playing session with a matchPlayers row. Any
   * failure is logged and ignored — the contract forbids gating play on it.
   */
  private async attachLedger(session: TSession): Promise<void> {
    const matchId = this.ledgerMatchId
    if (!matchId) return
    try {
      const res = await joinFreeplay(matchId, session.wallet, this.entryFee)
      if (this.sessions.get(session.wallet) !== session) return
      if (res === null) return // no DB / DB error — play on, ledger-free
      if ('error' in res) {
        // Already-active row somewhere. If it belongs to THIS match it is a
        // stranded session from a crash — adopt it so the pot comes back.
        const stranded = await getActivePlayerRow(matchId, session.wallet)
        if (!stranded) return // another region owns it — still play, no ledger
        if (this.sessions.get(session.wallet) !== session) return
        session.ledger = true
        session.pot = Number(stranded.currentPot)
      } else {
        session.ledger = true
        session.pot = Number(res.player.currentPot)
      }
      session.socket?.emit('freeplay:pot', { pot: session.pot, kills: session.kills })
    } catch (err) {
      console.error(`[freeplay:${this.game}] ledger attach failed (ignored):`, err)
    }
  }

  /** Rebind an existing session to a (new) socket and cancel the grace. */
  private resume(session: TSession, socket: Socket): void {
    const old = session.socket
    if (old && old.id !== socket.id) {
      // Old socket may still be live (second tab) — drop its routing; its
      // eventual disconnect becomes a harmless no-op.
      this.bySocket.delete(old.id)
      this.bindings.delete(old.id)
    }
    session.socket = socket
    session.disconnectedAt = null
    session.input = null // fresh input stream from the new socket
    this.bySocket.set(socket.id, session)
    this.bindings.set(socket.id, this)

    // Respawns are DEFERRED while disconnected (permanent world only — see
    // tick()); if one came due during the grace window, run it now.
    if (
      !this.isLobby &&
      !session.alive &&
      session.respawnAt !== null &&
      Date.now() >= session.respawnAt
    ) {
      this.doRespawn(session)
    }

    this.emitJoined(session)
    if (session.ledger) void this.reconcile(session)
  }

  /** The freeplay:joined handshake (+ a pot snapshot for the HUD). */
  private emitJoined(session: TSession): void {
    const now = Date.now()
    const payload: JoinedPayload = {
      matchId: this.matchId,
      playerId: session.id, // opaque id — never the wallet
      mode: this.mode,
      ...this.sectorStamp(),
      game: this.game,
      status: this._status,
      entryFee: this.entryFee,
      world: {
        w: this.bounds.maxX - this.bounds.minX,
        h: this.bounds.maxY - this.bounds.minY,
        game: this.game,
        bounds: this.bounds,
      },
      tick: TICK_RATE,
      startsIn: this.startAt === null ? 0 : Math.max(0, this.startAt - now),
      players: [...this.sessions.values()].map((s) => ({ id: s.id, name: s.name })),
    }
    session.socket?.emit('freeplay:joined', payload)
    session.socket?.emit('freeplay:pot', { pot: session.pot, kills: session.kills })
    if (this.isLobby) session.socket?.emit('freeplay:match_state', this.matchStatePayload(now))
  }

  // ────────────────────────────────────────────────
  // Lobby lifecycle
  // ────────────────────────────────────────────────

  /**
   * Close the roster and start the countdown. Called by lobby.ts once the
   * queue has handed over its players and every one of them has joined.
   * Idempotent — a second call is ignored.
   */
  beginMatch(): void {
    if (!this.isLobby || this.startAt !== null || this._status !== 'waiting') return
    const now = Date.now()
    this.startAt = now + MATCH_COUNTDOWN_MS
    this.deadline = this.startAt + MATCH_MAX_DURATION_MS
    const found: MatchFoundPayload = {
      game: this.game,
      mode: this.mode,
      ...this.sectorStamp(), // sector + difficulty → the client's zone
      matchId: this.matchId,
      startsIn: MATCH_COUNTDOWN_MS,
      players: [...this.sessions.values()].map((s) => ({ id: s.id, name: s.name })),
    }
    this.broadcast('freeplay:match_found', found)
    this.broadcastMatchState(now)
  }

  private matchStatePayload(now: number): MatchStatePayload {
    return {
      game: this.game,
      mode: this.mode,
      ...this.sectorStamp(),
      matchId: this.matchId,
      status: this._status,
      alive: this.aliveCount(),
      total: this.sessions.size,
      startsIn: this.startAt === null ? 0 : Math.max(0, this.startAt - now),
    }
  }

  private broadcastMatchState(now: number): void {
    this.broadcast('freeplay:match_state', this.matchStatePayload(now))
  }

  /** Emit one event to every attached socket (spectating losers included). */
  private broadcast(event: string, payload: unknown): void {
    for (const session of this.sessions.values()) session.socket?.emit(event, payload)
  }

  protected aliveCount(): number {
    let n = 0
    for (const s of this.sessions.values()) if (s.alive && !s.eliminated) n++
    return n
  }

  /** Sessions that still have a live socket (quitters keep their standings
   *  row but stop counting as an audience). */
  private connectedCount(): number {
    let n = 0
    for (const s of this.sessions.values()) if (s.socket) n++
    return n
  }

  /**
   * Match-over check — the same TRIGGER for both modes (one player left, the
   * hard deadline, or an empty world); only the RESULT differs (lms crowns
   * that survivor, slayer crowns nobody and publishes the kill board). Only
   * ever runs while the match is RUNNING, so an empty/1-player world during
   * the countdown can never end instantly (contract).
   */
  private checkMatchEnd(now: number): void {
    if (!this.isLobby || this._status !== 'running') return
    if (this.connectedCount() === 0) {
      this.endMatch('empty')
      return
    }
    if (this.aliveCount() <= 1) {
      this.endMatch('last_standing')
      return
    }
    if (this.deadline !== null && now >= this.deadline) this.endMatch('timeout')
  }

  /**
   * Finish a lobby match: place the survivors, ship the scoreboard to
   * everybody, stop the loop and release the sockets. The world object
   * lingers briefly so a late `freeplay:join` still gets the result.
   */
  private endMatch(reason: MatchEndPayload['reason']): void {
    if (this.ended || !this.isLobby) return
    // `ended` is the exactly-once guard for the scoreboard AND for the stats
    // write below — flipped synchronously, before anything can await.
    this.ended = true
    // Was this a match that actually got played? A lobby that emptied during
    // the countdown never ran, and a shutdown is the server's fault — neither
    // may write a loss onto anyone's record. (shutdown() sets 'running'
    // itself so endMatch can take its normal path, hence the reason check.)
    const wasPlayed = this._status === 'running' && reason !== 'shutdown'
    this._status = 'ended'

    if (this.mode === 'slayer') {
      // SLAYER HAS NO WINNER (contract). Everybody — survivors and the
      // eliminated alike — is RANKED by the kills they scored; `place` here
      // is a leaderboard position, not a verdict, and `winner` is forced to
      // null in buildMatchEnd(). Nobody wins, nobody loses.
      const ranked = [...this.sessions.values()].sort(
        (a, b) => b.kills - a.kills || b.score - a.score
      )
      ranked.forEach((s, i) => {
        s.place = i + 1
      })
    } else {
      // LMS — unchanged: the last player alive wins. Survivors are placed
      // ahead of everyone the eliminations already ranked from the bottom up.
      const survivors = [...this.sessions.values()].filter((s) => s.alive && !s.eliminated)
      survivors.sort((a, b) => b.score - a.score)
      survivors.forEach((s, i) => {
        s.place = i + 1
      })
    }

    // STATS — LMS writes win/loss, SLAYER writes 'none' (no win condition, so
    // no win rate — K/D only). Fire-and-forget, after placements exist.
    if (wasPlayed) this.recordMatchResults()

    // RANK — the 'ffa' ladder. Same exactly-once guard (`this.ended`, flipped
    // synchronously at the top of this method), same "only a match that was
    // actually played" rule as stats: a lobby that emptied during the
    // countdown, or a match killed by a server shutdown, must not move
    // anyone's RP. Fire-and-forget: it never throws and never blocks the
    // scoreboard below.
    if (wasPlayed) this.settleRanked()

    const payload = this.buildMatchEnd(reason)
    this.broadcast('freeplay:match_end', payload)
    this.broadcastMatchState(Date.now())

    if (this.interval) clearInterval(this.interval)
    this.interval = null

    // Release routing immediately: a client that clicks "play again" must
    // reach the queue, not this dead world.
    for (const [socketId, world] of this.bindings) {
      if (world === this) this.bindings.delete(socketId)
    }
    this.bySocket.clear()

    const linger = setTimeout(() => this.onEnded?.(this), MATCH_END_LINGER_MS)
    // Never hold the process open for a finished match.
    ;(linger as { unref?: () => void }).unref?.()
  }

  /** slayer scores KILLS (its "points"), lms scores survival score. */
  private pointsOf(session: TSession): number {
    return this.mode === 'slayer' ? session.kills : session.score
  }

  private buildMatchEnd(reason: MatchEndPayload['reason']): MatchEndPayload {
    const isSlayer = this.mode === 'slayer'
    const standings: StandingEntry[] = [...this.sessions.values()]
      .map((s) => ({
        id: s.id,
        name: s.name,
        kills: s.kills,
        score: s.score,
        points: this.pointsOf(s),
        place: s.place ?? 999,
        alive: s.alive && !s.eliminated,
      }))
      .sort((a, b) =>
        // slayer is a KILL-COUNT board: rank by kills, break ties on placement.
        isSlayer ? b.kills - a.kills || a.place - b.place : a.place - b.place
      )
    // SLAYER: winner is ALWAYS null — the mode has no winner and no loser.
    // LMS: the last player standing (place 1).
    const winnerRow = isSlayer
      ? null
      : ([...this.sessions.values()].find((s) => s.place === 1) ?? null)
    return {
      game: this.game,
      mode: this.mode,
      ...this.sectorStamp(),
      matchId: this.matchId,
      reason,
      winner: winnerRow ? { id: winnerRow.id, name: winnerRow.name } : null,
      scoring: isSlayer ? 'kills' : 'survival',
      standings,
    }
  }

  // ────────────────────────────────────────────────
  // STATS (match_results) — see the import header for the rules
  // ────────────────────────────────────────────────

  /** Deaths taken by a session so far (0 when it has never died). */
  private deathsOf(session: TSession): number {
    return this.deathsBySession.get(session.id) ?? 0
  }

  /**
   * Count one death against a session. Called for PVP victims and for
   * environment kills — never for a quit/disconnect, which is a forfeit
   * rather than a death and must not dent someone's K/D.
   */
  private countDeath(session: TSession): void {
    this.deathsBySession.set(session.id, this.deathsOf(session) + 1)
  }

  /**
   * Lobby match end: one row per seat.
   *
   * LMS — a real win condition: place 1 wins, everyone else loses (including
   *   players who forfeited by leaving — that is what a forfeit is).
   * SLAYER — NO WINNER, therefore NO win/loss row (contract "STATS IMPACT").
   *   Every seat is written with result 'none' plus kills/deaths/score, so a
   *   slayer match feeds K/D and the history panel but can NEVER move anyone's
   *   win rate. `placement` still rides along as the kill ranking.
   *
   * Cells and asteroids track K/D in EVERY mode, so kills/deaths always ride
   * along. The `mode` column stays the bare 'slayer' | 'lms' (the sector is a
   * matchmaking detail, not a stats vocabulary) and is never the free-play
   * marker, which belongs to the permanent world alone.
   *
   * The opponent field is only filled for a 2-player match, where a single
   * username actually describes the opposition; a bigger field cannot be, so
   * it stays null. Names come from socket.data.username — never a wallet.
   */
  private recordMatchResults(): void {
    const sessions = [...this.sessions.values()]
    if (sessions.length === 0) return
    const startedAt = this.startAt ?? Date.now()
    const durationMs = Math.max(0, Date.now() - startedAt)
    // ONE decision for the whole table: slayer has no verdict at all.
    const hasVerdict = this.mode !== 'slayer'

    const rows: RecordResultInput[] = sessions.map((s) => {
      const result: MatchOutcome = hasVerdict
        ? s.place === 1
          ? 'win'
          : 'loss'
        : NO_RESULT // slayer: nobody wins, nobody loses
      return {
        matchId: this.matchId, // queue uuid; a non-uuid is stored as null
        wallet: s.wallet,
        gameKey: this.game, // 'cells' | 'asteroids'
        mode: this.mode, // 'slayer' | 'lms' — never the free-play marker
        result,
        kills: s.kills,
        deaths: this.deathsOf(s),
        score: s.score,
        placement: s.place,
        opponentUsername:
          sessions.length === 2
            ? (sessions.find((o) => o.wallet !== s.wallet)?.name ?? null)
            : null,
        durationMs,
      }
    })

    void recordResults(rows) // never throws — safe to call from a tick path
  }

  // ────────────────────────────────────────────────
  // RANK (Ranked 2.0) — the 'ffa' ladder
  // ────────────────────────────────────────────────

  /**
   * Settle the finished lobby match on the shared 'ffa' rating ladder.
   *
   * ORDERING — this is the one real design decision in here:
   *
   *   LMS    is ordered by FINISHING PLACEMENT. `place` is already the whole
   *          verdict of the mode (1 = last one standing), so it is passed
   *          straight through. Equal placements are impossible in LMS.
   *
   *   SLAYER is ordered by KILL COUNT. ⚠️ JUDGEMENT CALL, flagged for the
   *          owner: slayer deliberately has NO WINNER on the results screen
   *          (`winner` is forced to null and stats write result 'none'), so
   *          the ordering here exists ONLY to give the rating model a
   *          relative result to learn from — nobody is crowned by it. Kills
   *          are passed as `score`, which settleRankedFfa competition-ranks,
   *          so players on the same kill count share a placement and are
   *          rated as having DRAWN with each other. That is the honest
   *          reading of "no winner": you are rated against the people you
   *          out-fragged, and tied with the people you matched.
   *          The alternative (rate slayer on nothing at all) would make an
   *          entire online mode unranked, which the contract does not want.
   *
   * WHY NOT `place` FOR SLAYER: endMatch already sorts slayer sessions by
   * kills and stamps `place` 1..N — but that ranking BREAKS TIES arbitrarily
   * (by score, then by iteration order). Feeding those to the rating model
   * would invent wins between players who genuinely tied. Passing raw kills
   * and letting the settle layer competition-rank them keeps ties as ties.
   *
   * Never called for free play (no outcome to rate — see the rank note in
   * the imports), and never for a match that was not actually played.
   */
  private settleRanked(): void {
    if (!this.isLobby) return
    if (this.mode !== 'slayer' && this.mode !== 'lms') return

    const sessions = [...this.sessions.values()]
    if (sessions.length < 2) return // no field → nothing to rate against

    const isSlayer = this.mode === 'slayer'
    const standings: RankedStanding[] = sessions.map((s) => ({
      wallet: s.wallet,
      // SLAYER: raw kills, competition-ranked by the settle layer (ties stay
      // ties). LMS: the finishing placement, which is the result itself.
      ...(isSlayer
        ? { score: s.kills }
        : { placement: s.place ?? sessions.length }),
      kills: s.kills, // history bookkeeping in both modes
    }))

    // Snapshot the sockets NOW: endMatch releases routing immediately after
    // this call, and the settle below is async. `id` is the opaque public id
    // clients already key standings rows by — the wallet never leaves here.
    const audience = sessions.map((s) => ({
      wallet: s.wallet,
      id: s.id,
      socket: s.socket,
    }))

    void settleRankedFfa(this.game, standings, this.matchId, this.mode)
      .then((settled) => {
        if (!settled) return // no db / not enough rated players — nothing to say
        const byWallet = new Map(audience.map((a) => [a.wallet, a]))
        // publicRating strips `wallet`, `mu` and `sigma`; `id` is re-attached
        // so a client can line the RP change up with its standings row.
        const results = settled.map((r) => ({
          id: byWallet.get(r.wallet)?.id ?? null,
          ...publicRating(r),
        })) satisfies Array<PublicRating & { id: string | null }>

        const payload = {
          game: this.game,
          mode: this.mode,
          matchId: this.matchId,
          ladder: 'ffa' as const,
          results,
        }
        // Emitted as a FOLLOW-UP to freeplay:match_end (which has already
        // gone out by now): the scoreboard must never wait on a database.
        for (const a of audience) a.socket?.emit('freeplay:match_ranked', payload)
      })
      .catch((err) => {
        // settleRankedFfa swallows its own errors; this is belt-and-braces so
        // a rating failure can never surface as an unhandled rejection.
        console.error(`[freeplay:${this.game}/${this.mode}] rank settle failed:`, err)
      })
  }

  /**
   * Free-play session end (cash-out, environment elimination, leave, or the
   * disconnect-grace auto-cash-out — they all funnel through despawn()).
   *
   * Free play has NO win condition, so this writes kills/deaths/score ONLY:
   * `mode: FREEPLAY_MODE` makes statsService force result 'none', which every
   * win-rate aggregate excludes. A session that did nothing at all (no kills,
   * no deaths, no score) is skipped so joining and immediately leaving does
   * not litter the history panel.
   */
  private recordFreeplaySession(session: TSession): void {
    const deaths = this.deathsOf(session)
    if (session.kills === 0 && deaths === 0 && session.score === 0) return

    void recordResult({
      matchId: this.matchId, // permanent-world ids are often not uuids → null
      wallet: session.wallet,
      gameKey: this.game,
      mode: FREEPLAY_MODE, // THE free-play marker — never 'free_play'
      result: 'none', // forced by statsService anyway; explicit for readers
      kills: session.kills,
      deaths,
      score: session.score,
      durationMs: Math.max(0, Date.now() - session.joinedAt),
    })
  }

  /** Knock a player out of a lobby match for good (death, rock, or quit). */
  private eliminate(session: TSession, reason: string, by: string | null): void {
    if (session.eliminated) return
    session.eliminated = true
    session.alive = false
    session.respawnAt = null
    session.input = null
    // Place = everyone still standing after this, plus one.
    session.place = this.aliveCount() + 1
    session.socket?.emit('freeplay:eliminated', {
      reason,
      by,
      // SLAYER has no placement to report — dying is not losing there, and
      // the final kill ranking is only known at match end. LMS keeps the
      // live "you finished Nth" number.
      place: this.mode === 'slayer' ? null : session.place,
      kills: session.kills,
      score: session.score,
      potLost: 0, // no money in lobby modes
    })
    // NOTE: the session deliberately STAYS in `sessions` — it is the
    // player's standings row, and a still-connected loser keeps receiving
    // state frames so they can spectate until the scoreboard arrives.
  }

  // ────────────────────────────────────────────────
  // Socket event entry points (routed by index.ts)
  // ────────────────────────────────────────────────

  /** Last-write-wins input slot; parse (zod) is delegated to the game. */
  handleInput(socketId: string, raw: unknown): void {
    const session = this.bySocket.get(socketId)
    if (!session || !session.alive) return
    if (this._status !== 'running') return // frozen during the countdown
    const input = this.parseInput(raw)
    if (input === null) return // invalid shape — silently ignored
    session.input = input
  }

  handleCashoutStart(socketId: string): void {
    if (this.isLobby) return // no money, no cash-out in a match
    const session = this.bySocket.get(socketId)
    if (!session || !session.alive) return
    if (session.cashout !== 'none') return // already holding / processing
    session.cashout = 'holding'
    session.holdStartAt = Date.now()
    // Movement penalty is applied by the game's step() via moveScale().
  }

  handleCashoutCancel(socketId: string): void {
    if (this.isLobby) return
    const session = this.bySocket.get(socketId)
    if (!session) return
    if (session.cashout !== 'holding') return // processing can't be cancelled
    session.cashout = 'none'
    session.holdStartAt = null
  }

  /** Voluntary leave. Permanent world: despawn (+ best-effort cash-out).
   *  Lobby: a forfeit — you are eliminated and the match may end. */
  handleLeave(socketId: string): void {
    const session = this.bySocket.get(socketId)
    if (!session) return
    if (this.isLobby) {
      // Forfeit: keep the standings row, drop the routing, end if the last
      // opponent just walked away.
      this.eliminate(session, 'left', null)
      this.releaseSocket(session)
      session.socket = null
      this.checkMatchEnd(Date.now())
      return
    }
    this.beginCashout(session)
  }

  /**
   * Disconnect. Permanent world: 60 s grace — the body stays in-world and
   * killable, inputs zeroed, a reconnect resumes. Lobby: quitting a match
   * is a forfeit (there is no rejoin), so the player is eliminated and the
   * match can finish instead of waiting on a ghost.
   */
  handleDisconnect(socketId: string): void {
    const session = this.bySocket.get(socketId)
    if (!session) return
    this.bySocket.delete(socketId)
    this.bindings.delete(socketId)
    if (session.socket?.id !== socketId) return // stale (already rebound)
    session.socket = null
    session.disconnectedAt = Date.now()
    session.input = null

    if (this.isLobby) {
      // No mid-match rejoin: leaving a lobby match is a forfeit, so the
      // survivors get their result instead of waiting on a ghost body.
      this.eliminate(session, 'left', null)
      this.checkMatchEnd(Date.now())
      return
    }

    if (session.cashout === 'holding') {
      // A hold can't be completed while gone; processing is left to finish.
      session.cashout = 'none'
      session.holdStartAt = null
    }
  }

  private releaseSocket(session: TSession): void {
    if (!session.socket) return
    this.bySocket.delete(session.socket.id)
    this.bindings.delete(session.socket.id)
  }

  // ────────────────────────────────────────────────
  // Money flows — permanent world only, ALL best-effort
  // ────────────────────────────────────────────────

  /**
   * Cash a session out at its current pot and despawn it. With no ledger
   * this is just a despawn with a zero-payout confirmation, so the client
   * flow is identical whether or not a database exists.
   */
  protected beginCashout(session: TSession): void {
    if (session.cashout === 'processing') return // exactly-once entry
    session.cashout = 'processing'
    session.holdStartAt = null
    session.input = null

    if (!this.hasLedger || !session.ledger) {
      session.socket?.emit('freeplay:cashout_confirmed', {
        payout: session.pot,
        kills: session.kills,
      })
      this.despawn(session)
      return
    }

    void cashOut(this.ledgerMatchId!, session.wallet)
      .then((res) => {
        // Session may have despawned while the DB round-tripped.
        if (this.sessions.get(session.wallet) !== session) return
        if (res) {
          session.socket?.emit('freeplay:cashout_confirmed', {
            payout: Number(res.payout),
            kills: session.kills,
          })
        } else {
          // Claim lost (killed in the same instant) or a DB hiccup. Money
          // is not a gate: the player still leaves the world cleanly.
          session.socket?.emit('freeplay:cashout_confirmed', {
            payout: session.pot,
            kills: session.kills,
          })
        }
        this.despawn(session)
      })
      .catch((err) => {
        console.error(`[freeplay:${this.game}] cashOut failed (ignored):`, err)
        if (this.sessions.get(session.wallet) === session) this.despawn(session)
      })
  }

  /**
   * Player-vs-player kill. Synchronously marks the victim dead (so the same
   * tick can't double-kill) and credits the killer IN MEMORY, then settles
   * the (optional) money asynchronously.
   */
  protected resolveKill(killer: TSession, victim: TSession): void {
    if (!victim.alive || killer === victim) return

    victim.alive = false
    victim.input = null
    victim.killedBy = killer.name
    if (victim.cashout === 'holding') {
      victim.cashout = 'none' // death interrupts the hold
      victim.holdStartAt = null
    }

    // Scoring is in-memory and authoritative (it must work without a DB).
    // The score itself is added by the GAME right before it calls us, using
    // its own practice-mode value (cells +20, asteroids +100 per kill).
    killer.kills++
    this.countDeath(victim) // stats bookkeeping only — the sim ignores it

    if (this.isLobby) {
      // Lobby modes: death is permanent. slayer counts kills, lms counts
      // survival — both end at last man standing.
      this.eliminate(victim, 'killed', killer.name)
      killer.socket?.emit('freeplay:kill', { victimName: victim.name, earned: 0 })
      killer.socket?.emit('freeplay:pot', { pot: killer.pot, kills: killer.kills })
      this.checkMatchEnd(Date.now())
      return
    }

    // Permanent world: respawn after the delay.
    victim.respawnAt = Date.now() + RESPAWN_DELAY_MS
    killer.socket?.emit('freeplay:kill', { victimName: victim.name, earned: 0 })
    killer.socket?.emit('freeplay:pot', { pot: killer.pot, kills: killer.kills })
    victim.socket?.emit('freeplay:killed', {
      by: killer.name,
      potLost: victim.pot,
      respawnIn: RESPAWN_DELAY_MS,
    })

    if (!this.hasLedger || !victim.ledger || !killer.ledger) return

    // Best-effort settlement — the outcome only ever refreshes the pot
    // CACHE; nothing above depends on it.
    // NOTE: no rating call here, deliberately. A free-play kill is not a
    // match result — see the rank note in the imports. Ranked kill-count
    // scoring lives in SLAYER, which has a start, an end and a field to be
    // ranked against; this world has none of those.
    void onKill(this.ledgerMatchId!, killer.wallet, victim.wallet, this.entryFee)
      .then((res) => {
        if (!res) return
        if (this.sessions.get(killer.wallet) === killer) {
          killer.pot = Number(res.killerPot)
          killer.socket?.emit('freeplay:pot', { pot: killer.pot, kills: killer.kills })
        }
        if (this.sessions.get(victim.wallet) === victim) victim.pot = this.entryFee
      })
      .catch((err) => {
        console.error(`[freeplay:${this.game}] onKill failed (ignored):`, err)
      })
  }

  /**
   * Environment kill (asteroid collision, or dying outside the safe zone).
   * Permanent world: the session ends with no respawn (and the house takes
   * the pot when a ledger exists). Lobby: a plain elimination — the rock /
   * the zone counts as nobody's kill.
   */
  protected resolveEnvironmentKill(
    victim: TSession,
    reason: 'asteroid' | 'zone'
  ): void {
    if (!victim.alive) return
    victim.alive = false
    victim.respawnAt = null // eliminated — no respawn, ever
    victim.input = null
    this.countDeath(victim) // a rock still counts as a death for K/D

    if (this.isLobby) {
      this.eliminate(victim, reason, null)
      this.checkMatchEnd(Date.now())
      return
    }

    const potLost = victim.pot
    if (!this.hasLedger || !victim.ledger) {
      victim.socket?.emit('freeplay:eliminated', { reason, potLost, place: null })
      this.despawn(victim)
      return
    }

    void onEnvironmentKill(this.ledgerMatchId!, victim.wallet)
      .then((res) => {
        if (this.sessions.get(victim.wallet) !== victim) return
        victim.socket?.emit('freeplay:eliminated', {
          reason,
          potLost: res ? Number(res.potLost) : potLost,
          place: null,
        })
        this.despawn(victim)
      })
      .catch((err) => {
        console.error(`[freeplay:${this.game}] onEnvironmentKill failed (ignored):`, err)
        if (this.sessions.get(victim.wallet) === victim) this.despawn(victim)
      })
  }

  /** Refresh one session's pot render-cache from the DB. Best-effort. */
  private async reconcile(session: TSession): Promise<void> {
    if (!this.hasLedger || !session.ledger) return
    try {
      const row = await getActivePlayerRow(this.ledgerMatchId!, session.wallet)
      if (!row) return // not active (mid-settlement) — a later pass catches up
      if (this.sessions.get(session.wallet) !== session) return
      session.pot = Number(row.currentPot)
    } catch (err) {
      console.error(`[freeplay:${this.game}] reconcile failed (ignored):`, err)
    }
  }

  // ────────────────────────────────────────────────
  // Despawn / respawn
  // ────────────────────────────────────────────────

  /** Remove every trace of a session (a forgotten Map entry per disconnect
   *  is a slow leak in a process that runs for weeks). */
  protected despawn(session: TSession): void {
    // STATS: a free-play session ends HERE and nowhere else (cash-out,
    // elimination, leave, disconnect-grace, shutdown all funnel through).
    // Exactly-once by construction — the registry still points at THIS
    // session on the first call and never again afterwards, so a duplicate
    // despawn (a racing cash-out + elimination) records nothing extra.
    if (!this.isLobby && this.sessions.get(session.wallet) === session) {
      this.recordFreeplaySession(session)
    }
    this.deathsBySession.delete(session.id)

    this.sessions.delete(session.wallet)
    this.releaseSocket(session)
    session.input = null
    this.onDespawn(session)
  }

  /** Fresh life after a pvp death (permanent world only). */
  private doRespawn(session: TSession): void {
    this.spawn(session)
    session.alive = true
    session.respawnAt = null
    session.pot = this.entryFee // mirrors the DB reset done by onKill
    session.socket?.emit('freeplay:respawn', {
      pot: session.pot,
      respawnPot: session.pot,
      killedBy: session.killedBy,
    })
    session.killedBy = null
  }

  // ────────────────────────────────────────────────
  // THE tick (20 Hz)
  // ────────────────────────────────────────────────

  private tick(): void {
    try {
      const now = Date.now()

      if (this._status === 'ended') return

      // ── lobby countdown: broadcast the frozen world, start on time ──
      if (this._status === 'waiting') {
        if (this.startAt !== null && this.connectedCount() === 0) {
          // Everybody vanished before the first simulated tick.
          this.endMatch('empty')
          return
        }
        if (this.startAt !== null && now >= this.startAt) {
          this._status = 'running'
          this.broadcastMatchState(now)
        } else {
          // Frozen world, live picture: rebuild the query grids so the
          // countdown screen shows the real spawn positions and scenery.
          this.refreshGrids()
          this.rebuildLeaderboard()
          this.broadcastStates(now)
          return
        }
      }

      // Empty permanent world → early-exit for pennies. The interval stays
      // alive — that persistence IS the "permanent server".
      if (this.sessions.size === 0) {
        if (this.isLobby) this.checkMatchEnd(now)
        return
      }

      // 1) Lifecycle scan (permanent world only: grace, holds, respawns).
      if (!this.isLobby) this.scanPermanentLifecycle(now)

      // 2) Game simulation — fixed dt so setInterval jitter never changes
      // physics. Subclasses sub-step this at 60 Hz internally.
      this.step(now, TICK_MS / 1000)

      // 3) Scoreboard.
      this.rebuildLeaderboard()

      // 4) Interest-managed broadcast (built by the game).
      this.broadcastStates(now)

      // 5) Lobby: did that tick finish the match?
      this.checkMatchEnd(now)

      // 6) Slow reconcile: one session per second re-reads its DB row so the
      // pot render-cache can never drift far from the truth.
      if (this.hasLedger && ++this.tickCount % TICK_RATE === 0) this.reconcileNext()
    } catch (err) {
      // A tick must NEVER kill the interval — log and play on.
      console.error(`[freeplay:${this.game}/${this.mode}] tick failed:`, err)
    }
  }

  private scanPermanentLifecycle(now: number): void {
    for (const session of this.sessions.values()) {
      // 60 s disconnect grace expired → auto-cash-out at current pot.
      if (
        session.disconnectedAt !== null &&
        session.cashout !== 'processing' &&
        now - session.disconnectedAt >= DISCONNECT_GRACE_MS
      ) {
        this.beginCashout(session)
        continue
      }
      // Server-enforced 3 s hold: the client's UI timer is cosmetic.
      if (
        session.cashout === 'holding' &&
        session.holdStartAt !== null &&
        now - session.holdStartAt >= CASHOUT_HOLD_MS
      ) {
        this.beginCashout(session)
      }
      // Respawn when due — but only while CONNECTED, so an unmanned body
      // can't be farmed on repeat.
      if (
        !session.alive &&
        session.respawnAt !== null &&
        now >= session.respawnAt &&
        session.socket !== null
      ) {
        this.doRespawn(session)
      }
    }
  }

  private rebuildLeaderboard(): void {
    this.leaderboard = [...this.sessions.values()]
      .sort((a, b) =>
        // slayer/lms are scored on kills; free play still shows pots.
        this.isLobby ? b.kills - a.kills || b.score - a.score : b.pot - a.pot
      )
      .slice(0, LEADERBOARD_SIZE)
      .map((s) => ({ name: s.name, pot: s.pot, kills: s.kills, score: s.score }))
  }

  /** One `freeplay:state` per attached socket, mode/lifecycle stamped. */
  private broadcastStates(now: number): void {
    const alive = this.aliveCount()
    for (const session of this.sessions.values()) {
      if (!session.socket) continue // grace window — nobody listening
      const state = this.buildState(session, now)
      state.mode = this.mode
      state.status = this._status
      state.alive = alive
      state.total = this.sessions.size
      state.startsIn = this.startAt === null ? 0 : Math.max(0, this.startAt - now)
      // Sector + difficulty ride every snapshot too, so a client that missed
      // (or reconnected after) freeplay:joined still renders the right zone.
      state.sector = this.sector
      state.difficulty = this.difficulty
      session.socket.emit('freeplay:state', state)
    }
  }

  /** Round-robin one wallet per call through the reconcile queue. */
  private reconcileNext(): void {
    if (this.reconcileQueue.length === 0) {
      this.reconcileQueue = [...this.sessions.keys()]
      if (this.reconcileQueue.length === 0) return
    }
    const wallet = this.reconcileQueue.pop()!
    const session = this.sessions.get(wallet)
    if (session) void this.reconcile(session)
  }

  // ────────────────────────────────────────────────
  // Graceful shutdown
  // ────────────────────────────────────────────────

  /**
   * Stop the world. Lobby matches are ended (with a scoreboard) so nobody
   * is left staring at a frozen canvas; the permanent world auto-cashes-out
   * every session (best-effort) so deploys can't strand a pot.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.isLobby) {
      this._status = 'running' // allow endMatch to run its normal path
      this.endMatch('shutdown')
      return
    }
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    const all = [...this.sessions.values()]
    await Promise.all(
      all.map(async (session) => {
        try {
          if (session.cashout === 'processing') return
          session.cashout = 'processing'
          if (this.hasLedger && session.ledger) {
            const res = await cashOut(this.ledgerMatchId!, session.wallet)
            if (res) {
              session.socket?.emit('freeplay:cashout_confirmed', {
                payout: Number(res.payout),
                kills: session.kills,
              })
            }
          }
        } catch (err) {
          console.error(`[freeplay:${this.game}] shutdown cash-out failed:`, err)
        } finally {
          this.despawn(session)
        }
      })
    )
  }

  // ────────────────────────────────────────────────
  // Shared helpers for subclasses
  // ────────────────────────────────────────────────

  /** Movement multiplier: holding a cash-out hinders movement (permanent
   *  world only — a lobby match has no cash-out at all). */
  protected moveScale(session: TSession): number {
    return session.cashout === 'none' ? 1 : CASHOUT_HOLD_PENALTY
  }

  /** All the game-agnostic session fields, ready to be spread into the
   *  game's concrete session object by newSession(). */
  protected baseFields(
    id: string,
    wallet: string,
    name: string,
    socket: Socket
  ): BaseSession<TInput> {
    return {
      id,
      wallet,
      name,
      socket,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: 0,
      alive: false, // join()/doRespawn() flip this after spawn()
      respawnAt: null,
      killedBy: null,
      eliminated: false,
      place: null,
      score: 0,
      pot: 0,
      kills: 0,
      ledger: false,
      cashout: 'none',
      holdStartAt: null,
      disconnectedAt: null,
      input: null,
      joinedAt: Date.now(),
    }
  }

  // ────────────────────────────────────────────────
  // Game hooks (implemented by cellsWorld / asteroidsWorld)
  // ────────────────────────────────────────────────

  /** zod-parse a raw freeplay:input payload; null = silently ignore. */
  protected abstract parseInput(raw: unknown): TInput | null

  /** Construct the game's concrete session object (spread baseFields). */
  protected abstract newSession(
    id: string,
    wallet: string,
    name: string,
    socket: Socket
  ): TSession

  /** (Re)set position + game-specific fields for a fresh life. Must pick a
   *  safe random spot — never trust anything client-side. */
  protected abstract spawn(session: TSession): void

  /** One fixed-dt simulation step: apply inputs, move, collide, kill. */
  protected abstract step(now: number, dt: number): void

  /** The per-player visible state for freeplay:state (interest-managed). */
  protected abstract buildState(session: TSession, now: number): Record<string, unknown>

  /** Rebuild the broadcast query grids WITHOUT simulating — used while a
   *  lobby match is still counting down. */
  protected abstract refreshGrids(): void

  /** Game-specific cleanup on despawn (bullets, food-delta sets, ...). */
  protected onDespawn(_session: TSession): void {
    // default: nothing extra to clean
  }
}
