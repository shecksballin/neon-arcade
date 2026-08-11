/**
 * WORLD BASE CLASS — the "permanent server" itself
 * ================================================
 * One instance per (game, REGION), created lazily on first join and alive
 * for as long as the process lives. The 20 Hz setInterval NEVER stops —
 * an empty world just early-exits each tick for pennies (design contract:
 * "never stops while process lives").
 *
 * Owns everything game-agnostic:
 *   - the tick loop (lifecycle scan → step → leaderboard → broadcast)
 *   - per-player input slots (last-write-wins, depth-1 "queues")
 *   - join / resume / respawn / despawn lifecycle
 *   - 60 s disconnect grace (body killable, inputs zeroed, timeout
 *     auto-cash-out, reconnect resume)
 *   - the server-enforced 3 s cash-out hold (+ movement penalty flag)
 *   - graceful shutdown (auto-cash-out every session)
 *
 * Game rules (movement, collisions, food, bullets, asteroids) live in the
 * subclasses via the abstract hooks at the bottom.
 *
 * MONEY (money doc §6): in-memory `session.pot` / `session.kills` are a
 * RENDER CACHE. Every mutation goes through wagerService (fired async, off
 * the tick loop); the in-memory copies are refreshed from the transaction
 * RESULTS, plus a slow background reconcile re-reads one session per second
 * from the DB so cache drift self-heals. No handler in this file computes
 * a pot value — it only copies what wagerService returns.
 */

import { randomUUID } from 'node:crypto'
import type { Socket } from 'socket.io'
import type { MatchPlayer } from '../../db/schema'
import {
  cashOut,
  getActivePlayerRow,
  joinFreeplay,
  onEnvironmentKill,
  onKill,
} from '../../services/wagerService'
import { freeplayKill } from '../../services/eloService'
import {
  CASHOUT_HOLD_MS,
  CASHOUT_HOLD_PENALTY,
  DISCONNECT_GRACE_MS,
  LEADERBOARD_SIZE,
  MAX_PLAYERS_PER_WORLD,
  RESPAWN_DELAY_MS,
  TICK_MS,
  TICK_RATE,
  emitFreeplayError,
  type BaseSession,
  type FreeplayGame,
  type JoinedPayload,
  type LeaderboardEntry,
  type WorldBounds,
} from './types'

/**
 * The generic-free public surface of a world. index.ts routes sockets to
 * worlds through this interface so a Map can hold CellsWorld and
 * AsteroidsWorld side by side without generic-variance gymnastics.
 */
export interface FreeplayWorld {
  readonly game: FreeplayGame
  join(socket: Socket): Promise<void>
  handleInput(socketId: string, raw: unknown): void
  handleCashoutStart(socketId: string): void
  handleCashoutCancel(socketId: string): void
  handleLeave(socketId: string): void
  handleDisconnect(socketId: string): void
  shutdown(): Promise<void>
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

  /** Top-5 pots, rebuilt each tick, read by subclasses in buildState. */
  protected leaderboard: LeaderboardEntry[] = []

  /** Round-robin cursor for the slow background pot reconcile. */
  private reconcileQueue: string[] = []

  private tickCount = 0
  private shuttingDown = false
  private readonly interval: ReturnType<typeof setInterval>

  constructor(
    public readonly game: FreeplayGame,
    /** The permanent matches row id for (game, REGION) — never settles. */
    protected readonly matchId: string,
    /** Entry fee snapshot from the match row (= pot after every respawn). */
    protected readonly entryFee: number,
    /** World geometry, shipped to clients in freeplay:joined. */
    protected readonly bounds: WorldBounds,
    /**
     * Shared socket.id → world registry owned by index.ts. The world
     * maintains its own entries so a despawn from INSIDE the tick loop
     * (cash-out, elimination) releases the binding without a callback web.
     */
    private readonly bindings: Map<string, FreeplayWorld>
  ) {
    // THE permanent loop. Started at construction, cleared only in
    // shutdown() (where the process is about to exit anyway).
    this.interval = setInterval(() => this.tick(), TICK_MS)
  }

  // ────────────────────────────────────────────────
  // Join / resume (async — runs OUTSIDE the tick loop)
  // ────────────────────────────────────────────────

  async join(socket: Socket): Promise<void> {
    // Trusted identity only — set by the handshake auth middleware.
    const wallet = socket.data.wallet as string
    // index.ts already refused unregistered accounts; fallback is defensive.
    const name = (socket.data.username as string | null) ?? 'Player'

    // RESUME: same wallet joining again = reconnect (grace window) or a
    // tab switch. Rebind the socket to the existing session — same public
    // id, same pot, same body (design: "reconnect resume").
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
    if (this.sessions.size >= MAX_PLAYERS_PER_WORLD) {
      emitFreeplayError(socket, 'world_full', 'This world is full — try again soon')
      return
    }

    this.joining.add(wallet)
    try {
      // ALL money through wagerService. Pattern 5 (one active session per
      // wallet, cross-region) is enforced by the DB's partial unique index
      // inside joinFreeplay — we never pre-check in JS.
      const res = await joinFreeplay(this.matchId, wallet, this.entryFee)
      if (res === null) {
        // Contract: free play REFUSES to run without a ledger.
        emitFreeplayError(socket, 'no_db', 'Wager ledger unavailable — free play is closed')
        return
      }

      let row: MatchPlayer
      if ('error' in res) {
        // The wallet already holds an 'active' row somewhere. If that row
        // is in THIS match, it is a stranded session from a crash (graceful
        // shutdown cashes everyone out) — ADOPT it so the player gets
        // their pot back instead of being locked out forever.
        const stranded = await getActivePlayerRow(this.matchId, wallet)
        if (!stranded) {
          emitFreeplayError(
            socket,
            'already_active',
            'This wallet already has an active free-play session'
          )
          return
        }
        row = stranded
      } else {
        row = res.player
      }

      // Build the session. Pot/kills are copied FROM THE DB ROW (render
      // cache seeded from truth, never computed here).
      const session = this.newSession(randomUUID(), wallet, name, socket)
      session.pot = Number(row.currentPot)
      session.kills = row.kills
      this.spawn(session) // game-specific position + fields
      session.alive = true
      this.sessions.set(wallet, session)

      if (socket.connected) {
        this.bySocket.set(socket.id, session)
        this.bindings.set(socket.id, this)
      } else {
        // Socket died during the DB awaits — we now hold an active row, so
        // enter the session in grace mode; the 60 s timeout cashes it out.
        session.socket = null
        session.disconnectedAt = Date.now()
      }

      this.emitJoined(session)
    } catch (err) {
      // Never let a join explosion take down the caller.
      console.error(`[freeplay:${this.game}] join failed:`, err)
      emitFreeplayError(socket, 'join_failed', 'Join failed — try again')
    } finally {
      this.joining.delete(wallet)
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

    // Respawns are DEFERRED while disconnected (see tick() — respawning an
    // unmanned body would let others farm entry-fee pots off it). If one
    // came due during the grace window, run it now.
    if (!session.alive && session.respawnAt !== null && Date.now() >= session.respawnAt) {
      this.doRespawn(session)
    }

    this.emitJoined(session)
    void this.reconcile(session) // re-sync the pot cache from the DB
  }

  /** The freeplay:joined handshake (+ a pot snapshot for the HUD). */
  private emitJoined(session: TSession): void {
    const payload: JoinedPayload = {
      matchId: this.matchId,
      playerId: session.id, // opaque id — never the wallet
      entryFee: this.entryFee,
      world: {
        w: this.bounds.maxX - this.bounds.minX,
        h: this.bounds.maxY - this.bounds.minY,
        game: this.game,
        bounds: this.bounds,
      },
      tick: TICK_RATE,
    }
    session.socket?.emit('freeplay:joined', payload)
    session.socket?.emit('freeplay:pot', { pot: session.pot, kills: session.kills })
  }

  // ────────────────────────────────────────────────
  // Socket event entry points (routed by index.ts)
  // ────────────────────────────────────────────────

  /** Last-write-wins input slot; parse (zod) is delegated to the game. */
  handleInput(socketId: string, raw: unknown): void {
    const session = this.bySocket.get(socketId)
    if (!session || !session.alive) return
    const input = this.parseInput(raw)
    if (input === null) return // invalid shape — silently ignored
    session.input = input
  }

  handleCashoutStart(socketId: string): void {
    const session = this.bySocket.get(socketId)
    if (!session || !session.alive) return
    if (session.cashout !== 'none') return // already holding / processing
    session.cashout = 'holding'
    session.holdStartAt = Date.now()
    // Movement penalty is applied by the game's step() via moveScale().
  }

  handleCashoutCancel(socketId: string): void {
    const session = this.bySocket.get(socketId)
    if (!session) return
    if (session.cashout !== 'holding') return // processing can't be cancelled
    session.cashout = 'none'
    session.holdStartAt = null
  }

  /** Voluntary leave = despawn + auto-cash-out at current pot (contract). */
  handleLeave(socketId: string): void {
    const session = this.bySocket.get(socketId)
    if (!session) return
    this.beginCashout(session)
  }

  /**
   * Disconnect = start the 60 s grace window. The body STAYS in the world
   * and killable (money doc §4 — otherwise pulling the plug protects a fat
   * pot); inputs are zeroed so it coasts. The tick loop watches the clock.
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
    if (session.cashout === 'holding') {
      // A hold can't be completed while gone; processing is left to finish.
      session.cashout = 'none'
      session.holdStartAt = null
    }
  }

  // ────────────────────────────────────────────────
  // Money flows (all async — fired OFF the tick loop)
  // ────────────────────────────────────────────────

  /**
   * Cash a session out at its current DB pot. Used by: completed 3 s hold,
   * voluntary leave, disconnect-grace timeout, graceful shutdown.
   * wagerService.cashOut is Pattern 1 (atomic claim) — exactly one of a
   * racing kill / duplicate cash-out can win, decided by the DB.
   */
  protected beginCashout(session: TSession): void {
    if (session.cashout === 'processing') return // exactly-once entry
    session.cashout = 'processing'
    session.holdStartAt = null
    session.input = null

    void cashOut(this.matchId, session.wallet).then((res) => {
      // Session may have despawned while the DB round-tripped.
      if (this.sessions.get(session.wallet) !== session) return
      if (res) {
        session.socket?.emit('freeplay:cashout_confirmed', {
          payout: Number(res.payout),
          kills: res.kills,
        })
        this.despawn(session)
      } else {
        // Claim lost: killed/eliminated in the same instant, or a DB
        // hiccup. If a kill won, its own flow already handled the session;
        // otherwise the player simply keeps playing. Re-sync the cache.
        session.cashout = 'none'
        if (session.socket) {
          emitFreeplayError(session.socket, 'cashout_failed', 'Cash out failed — try again')
        }
        void this.reconcile(session)
      }
    })
  }

  /**
   * Player-vs-player kill. Synchronously marks the victim dead (so the
   * same tick can't double-kill), then settles the money ASYNC via
   * wagerService.onKill (Patterns 3+6, one transaction). Pots/kill counts
   * are updated from the transaction RESULT — never computed here.
   */
  protected resolveKill(killer: TSession, victim: TSession): void {
    if (!victim.alive || killer === victim) return
    victim.alive = false
    victim.respawnAt = Date.now() + RESPAWN_DELAY_MS
    victim.killedBy = killer.name
    victim.input = null
    if (victim.cashout === 'holding') {
      victim.cashout = 'none' // death interrupts the hold
      victim.holdStartAt = null
    }

    void onKill(this.matchId, killer.wallet, victim.wallet, this.entryFee).then((res) => {
      if (!res) {
        // Not settled (victim's row wasn't 'active' — a cash-out claim won
        // the race — or a DB error). No money moved, so no kill events;
        // the victim still respawns in-world with their pot UNCHANGED.
        void this.reconcile(killer)
        void this.reconcile(victim)
        return
      }

      // Render-cache updates strictly from the transaction results.
      if (this.sessions.get(killer.wallet) === killer) {
        killer.pot = Number(res.killerPot)
        killer.kills = res.killerKills
        killer.socket?.emit('freeplay:kill', {
          victimName: victim.name,
          earned: Number(res.killerGets),
        })
        killer.socket?.emit('freeplay:pot', { pot: killer.pot, kills: killer.kills })
      }
      if (this.sessions.get(victim.wallet) === victim) {
        victim.pot = this.entryFee // DB reset the pot to the entry fee
        victim.socket?.emit('freeplay:killed', {
          by: killer.name,
          potLost: Number(res.victimPot),
          respawnIn: RESPAWN_DELAY_MS,
        })
      }

      // Per-kill ELO — fire-and-forget (eloService never throws; a lost
      // rating update is acceptable, unlike money).
      void freeplayKill(killer.wallet, victim.wallet, this.game, this.matchId)
    })
  }

  /**
   * Environment kill (asteroid collision). House takes the FULL pot, the
   * session ends with status='eliminated' and there is NO respawn (§4).
   */
  protected resolveEnvironmentKill(victim: TSession, reason: 'asteroid'): void {
    if (!victim.alive) return
    victim.alive = false
    victim.respawnAt = null // eliminated — no respawn, ever
    victim.input = null

    void onEnvironmentKill(this.matchId, victim.wallet).then((res) => {
      if (this.sessions.get(victim.wallet) !== victim) return
      // On a DB failure the row stays 'active' with the pot intact — the
      // player can rejoin and ADOPT it (see join). We still despawn here:
      // the in-world body is gone either way.
      victim.socket?.emit('freeplay:eliminated', {
        reason,
        potLost: res ? Number(res.potLost) : victim.pot,
      })
      this.despawn(victim)
    })
  }

  /** Refresh one session's pot render-cache from the DB (money doc §6). */
  private async reconcile(session: TSession): Promise<void> {
    const row = await getActivePlayerRow(this.matchId, session.wallet)
    if (!row) return // not active (mid-settlement) — a later pass catches up
    if (this.sessions.get(session.wallet) !== session) return
    session.pot = Number(row.currentPot)
    session.kills = row.kills
  }

  // ────────────────────────────────────────────────
  // Despawn / respawn
  // ────────────────────────────────────────────────

  /**
   * Remove every trace of a session (money doc §7: a forgotten Map entry
   * per disconnect is a slow leak). Grid entries vanish on the next
   * rebuild; game-owned extras are cleaned by onDespawn().
   */
  protected despawn(session: TSession): void {
    this.sessions.delete(session.wallet)
    if (session.socket) {
      this.bySocket.delete(session.socket.id)
      this.bindings.delete(session.socket.id)
    }
    session.input = null
    this.onDespawn(session)
  }

  /** Fresh life after a pvp death: new spawn state, pot = entry fee. */
  private doRespawn(session: TSession): void {
    this.spawn(session)
    session.alive = true
    session.respawnAt = null
    session.pot = this.entryFee // mirrors the DB reset done by onKill
    // `respawnPot`/`killedBy` are included alongside the contract's `pot`
    // (the design's Money section names them; a superset serves both).
    session.socket?.emit('freeplay:respawn', {
      pot: session.pot,
      respawnPot: session.pot,
      killedBy: session.killedBy,
    })
    session.killedBy = null
  }

  // ────────────────────────────────────────────────
  // THE tick (20 Hz, never stops)
  // ────────────────────────────────────────────────

  private tick(): void {
    try {
      // Empty world → early-exit for pennies. The interval stays alive —
      // that persistence IS the "permanent server".
      if (this.sessions.size === 0) return

      const now = Date.now()

      // 1) Lifecycle scan: grace timeouts, completed holds, due respawns.
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
        // Server-enforced 3 s hold: the client's UI timer is cosmetic —
        // THIS check is what actually pays out.
        // TODO(preset-cashout): money doc §4 also describes a lobby-preset
        // SOL threshold (matchPlayers.autoCashOutSol) with a 5 s poller —
        // the v1 event contract has no way to set it, so it's not wired.
        if (
          session.cashout === 'holding' &&
          session.holdStartAt !== null &&
          now - session.holdStartAt >= CASHOUT_HOLD_MS
        ) {
          this.beginCashout(session)
        }
        // Respawn when due — but only while CONNECTED. Respawning an
        // unmanned grace-window body would re-credit the entry fee for
        // anyone to farm on repeat; a killed disconnected player instead
        // waits (resume respawns instantly, timeout cashes out).
        if (
          !session.alive &&
          session.respawnAt !== null &&
          now >= session.respawnAt &&
          session.socket !== null
        ) {
          this.doRespawn(session)
        }
      }

      // 2) Game simulation (movement, collisions, kills) — fixed dt so
      // setInterval jitter never changes physics.
      this.step(now, TICK_MS / 1000)

      // 3) Leaderboard: top pots among live bodies (capped, tiny).
      this.leaderboard = [...this.sessions.values()]
        .filter((s) => s.alive)
        .sort((a, b) => b.pot - a.pot)
        .slice(0, LEADERBOARD_SIZE)
        .map((s) => ({ name: s.name, pot: s.pot }))

      // 4) Interest-managed broadcast: each player gets only what their
      // view circle can see (money doc §3) — built by the game.
      for (const session of this.sessions.values()) {
        if (!session.socket) continue // grace window — nobody listening
        session.socket.emit('freeplay:state', this.buildState(session, now))
      }

      // 5) Slow reconcile: one session per second re-reads its DB row so
      // the pot render-cache can never drift far from the truth.
      if (++this.tickCount % TICK_RATE === 0) this.reconcileNext()
    } catch (err) {
      // A tick must NEVER kill the interval — log and play on.
      console.error(`[freeplay:${this.game}] tick failed:`, err)
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
  // Graceful shutdown (money doc §7)
  // ────────────────────────────────────────────────

  /**
   * Auto-cash-out EVERY session, then stop the loop. Called from
   * shutdownFreeplay() on SIGINT/SIGTERM — deploys and restarts must not
   * strand pots. Sessions already mid-cash-out are skipped (their claim
   * either landed — Pattern 1 makes the outcome unambiguous — or the
   * stranded 'cashing_out' row surfaces for manual review, Pattern 7).
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    clearInterval(this.interval) // the process is exiting — loop's job is done
    const all = [...this.sessions.values()]
    await Promise.all(
      all.map(async (session) => {
        try {
          if (session.cashout === 'processing') return
          session.cashout = 'processing'
          const res = await cashOut(this.matchId, session.wallet)
          if (res) {
            session.socket?.emit('freeplay:cashout_confirmed', {
              payout: Number(res.payout),
              kills: res.kills,
            })
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

  /** Movement multiplier: holding/processing a cash-out hinders movement
   *  (cells scales speed, asteroids scales turn rate — both use this). */
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
      r: 0,
      alive: false, // join()/doRespawn() flip this after spawn()
      respawnAt: null,
      killedBy: null,
      pot: 0,
      kills: 0,
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

  /** (Re)set position + game-specific fields for a fresh life. Must pick
   *  a safe random spot — never trust anything client-side. */
  protected abstract spawn(session: TSession): void

  /** One fixed-dt simulation step: apply inputs, move, collide, kill
   *  (via resolveKill / resolveEnvironmentKill), maintain the grids. */
  protected abstract step(now: number, dt: number): void

  /** The per-player visible state for freeplay:state (interest-managed —
   *  VIEW_RADIUS query against the game's grids + own full state). */
  protected abstract buildState(session: TSession, now: number): Record<string, unknown>

  /** Game-specific cleanup on despawn (bullets, food-delta sets, ...). */
  protected onDespawn(_session: TSession): void {
    // default: nothing extra to clean
  }
}
