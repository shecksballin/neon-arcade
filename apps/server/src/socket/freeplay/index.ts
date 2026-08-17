/**
 * FREE PLAY / LOBBY ENTRY POINT — registerFreeplay(io, socket)
 * ============================================================
 * The socket-facing edge of the cells + asteroids worlds:
 *
 *   free_play  the permanent world (one per game, per region). Join
 *              anytime, no queue, no searching screen. Created LAZILY on
 *              the first join and alive for as long as the process lives.
 *              NOT QUEUEABLE — `freeplay:find` rejects it outright (the
 *              contract removed free play from the online path; practice
 *              still has it, and this world code stays exactly as it is).
 *   slayer     queue → match-scoped world → kill-count board, NO winner
 *   lms        queue → match-scoped world → last man standing
 *
 * SECTORS: every queueable mode names a sector (`eclipse` | `blitz`), giving
 * the online 2×2. The pair is collapsed server-side into the PRACTICE
 * difficulty code (10/11/12/13) via `difficultyFor()` and handed to the match
 * world, which stamps it onto `freeplay:joined` / `match_found` /
 * `match_state` / `match_end` and every snapshot so clients draw the same
 * zone the server simulates. A client never chooses the number.
 *
 * NO DATABASE REQUIRED (contract "NO WAGER / NO MONEY"): the permanent
 * world used to refuse to start when `ensureFreeplayMatch` returned null
 * (`freeplay:error { code:'no_db' }`). That gate is GONE — the world is
 * created either way and pot bookkeeping simply doesn't happen. Free play
 * works without a database.
 *
 * Event routing: every C→S payload is zod-validated (schemas in types.ts);
 * sockets are routed to their world via the shared `bindings` map that the
 * worlds keep up to date.
 *
 *   C→S  freeplay:join   { game, mode?, sector? }  mode defaults to
 *                                          'free_play'; a lobby mode enters
 *                                          the queue and REQUIRES a sector
 *   C→S  freeplay:find   { game, mode, sector }    explicit queue entry;
 *                                          mode is 'slayer' | 'lms' only
 *   C→S  freeplay:cancel { game, mode?, sector? }  leave the queue
 *   C→S  freeplay:input / cashout_start / cashout_cancel / leave
 *   S→C  freeplay:joined | state | match_found | match_state | match_end |
 *        match_ranked | kill | killed | respawn | eliminated | pot | error,
 *        plus the shared queue:status from socket/queue.ts
 *
 * RANK (Ranked 2.0): the two LOBBY modes settle on the shared 'ffa' rating
 * ladder when their match ends — LMS by finishing placement, SLAYER by kill
 * count (see world.ts → settleRanked). The permanent FREE PLAY world is
 * UNRANKED by design: it has no outcome, so nothing may move skill or RP for
 * it, and practice / local / vs-computer games never reach the server at all.
 *
 *   S→C  freeplay:match_ranked { game, mode, matchId, ladder:'ffa', results }
 *          A FOLLOW-UP to freeplay:match_end, emitted only if the settlement
 *          succeeded (there is a database and 2+ rated players). The
 *          scoreboard never waits on it. Each result carries the standings
 *          row's public `id`, the RP before/after/change and the derived
 *          rank badge — never a wallet, and never the hidden mu/sigma.
 */

import type { Server, Socket } from 'socket.io'
import { config } from '../../config/env'
import { ensureFreeplayMatch } from '../../services/wagerService'
import {
  FREE_PLAY_DIFFICULTY,
  cancelSchema,
  emitFreeplayError,
  findSchema,
  isLobbyMode,
  joinSchema,
  noPayloadSchema,
  type FreeplayGame,
} from './types'
import type { FreeplayWorld, WorldOptions } from './world'
import { CellsWorld } from './cellsWorld'
import { AsteroidsWorld } from './asteroidsWorld'
import {
  activeMatchWorlds,
  cancelAllLobbyQueues,
  cancelLobbyMatch,
  findLobbyMatch,
} from './lobby'

// ─────────────────────────────────────────────────
// Permanent world singletons (lazy, one per game for THIS region)
// ─────────────────────────────────────────────────

/** game → permanent free-play world. Populated on first successful join. */
const worlds = new Map<FreeplayGame, FreeplayWorld>()

/** game → in-flight creation, so concurrent first-joins share one attempt
 *  instead of racing ensureFreeplayMatch. */
const pendingWorlds = new Map<FreeplayGame, Promise<FreeplayWorld>>()

/** socket.id → the world that socket is playing in (permanent OR match).
 *  Shared with the World instances so a despawn that originates INSIDE a
 *  tick releases the route itself. */
const bindings = new Map<string, FreeplayWorld>()

/**
 * Find-or-lazily-create the permanent world for `game`.
 *
 * The database is OPTIONAL: when `ensureFreeplayMatch` returns null (no DB,
 * or a DB error) the world is still created, just without a ledger — play
 * is never gated on money bookkeeping.
 */
async function getPermanentWorld(game: FreeplayGame): Promise<FreeplayWorld> {
  const existing = worlds.get(game)
  if (existing) return existing

  let pending = pendingWorlds.get(game)
  if (!pending) {
    pending = (async (): Promise<FreeplayWorld> => {
      // The permanent matches row for (game, REGION) — created once, status
      // 'active' forever, never settles. Null = no ledger, play on anyway.
      const match = await ensureFreeplayMatch(game, config.REGION).catch((err) => {
        console.error('[freeplay] ensureFreeplayMatch threw (ignored):', err)
        return null
      })
      if (!match) {
        console.warn(
          `[freeplay] ${game}: no wager ledger available — running the permanent world in memory only`
        )
      }

      const options: WorldOptions = {
        mode: 'free_play',
        // The permanent world is practice's INFINITE sector: no zone at all.
        sector: null,
        difficulty: FREE_PLAY_DIFFICULTY,
        matchId: match?.id ?? `freeplay-${game}-${config.REGION}`,
        ledgerMatchId: match?.id ?? null,
        entryFee: Number(match?.betAmount ?? config.FREEPLAY_ENTRY_FEE),
        bindings,
      }
      const world: FreeplayWorld =
        game === 'cells' ? new CellsWorld(options) : new AsteroidsWorld(options)
      worlds.set(game, world)
      console.log(
        `[freeplay] ${game} permanent world started (region=${config.REGION}, match=${options.matchId}, ledger=${options.ledgerMatchId !== null})`
      )
      return world
    })().finally(() => pendingWorlds.delete(game))
    pendingWorlds.set(game, pending)
  }
  return pending
}

// ─────────────────────────────────────────────────
// registerFreeplay — per-connection event wiring
// ─────────────────────────────────────────────────

export function registerFreeplay(io: Server, socket: Socket): void {
  /** Online play requires a registered account (same rule + same event as
   *  every other game's matchmaking entry). */
  const requireAccount = (): boolean => {
    if (socket.data.username) return true
    socket.emit('gameAuthError', {
      code: 'no_account',
      message: 'Finish account setup to play online',
    })
    return false
  }

  // C→S freeplay:join { game, mode? } — region is NOT a payload field; this
  // server IS a region. mode defaults to 'free_play' so the shipped client
  // keeps working unchanged.
  socket.on('freeplay:join', (payload: unknown) => {
    const parsed = joinSchema.safeParse(payload)
    if (!parsed.success) {
      emitFreeplayError(socket, 'bad_payload', 'Invalid join payload')
      return
    }
    const { game, mode, sector } = parsed.data
    if (!requireAccount()) return

    // Already routed to a world on this socket? Same game AND mode (AND
    // sector, when the caller named one) → resume it; the world rebinds
    // idempotently, which is exactly what a match-scoped world needs when
    // the client mounts its canvas after the handoff. Anything else means
    // the player navigated — leave the old world cleanly instead of
    // refusing the new one.
    const bound = bindings.get(socket.id)
    if (bound) {
      const sameWorld =
        bound.game === game &&
        bound.mode === mode &&
        (sector === undefined || bound.sector === sector)
      if (sameWorld) {
        void bound.join(socket).catch((err) => {
          console.error('[freeplay] resume failed:', err)
          emitFreeplayError(socket, 'join_failed', 'Join failed — try again')
        })
        return
      }
      bound.handleLeave(socket.id)
    }

    // A lobby mode never joins a world directly — it queues, and it cannot
    // be queued without a sector (there would be no difficulty code, hence
    // no zone). Refuse rather than silently guess one.
    if (isLobbyMode(mode)) {
      if (!sector) {
        emitFreeplayError(socket, 'bad_payload', 'Pick a sector to play online')
        return
      }
      void findLobbyMatch(io, socket, game, mode, sector, bindings).catch((err) => {
        console.error('[freeplay] queue join failed:', err)
        emitFreeplayError(socket, 'join_failed', 'Matchmaking failed — try again')
      })
      return
    }

    void (async () => {
      try {
        const world = await getPermanentWorld(game)
        await world.join(socket)
      } catch (err) {
        console.error('[freeplay] join dispatch failed:', err)
        emitFreeplayError(socket, 'join_failed', 'Join failed — try again')
      }
    })()
  })

  // C→S freeplay:find { game, mode, sector } — explicit queue entry for one
  // of the four sector×mode combinations. `free_play` is NOT a valid mode
  // here (findSchema only accepts 'slayer' | 'lms'), so the online path can
  // no longer reach the permanent world at all.
  // Idempotent and NEVER silent (queue.ts emits queue:status every time).
  socket.on('freeplay:find', (payload: unknown) => {
    const parsed = findSchema.safeParse(payload)
    if (!parsed.success) {
      emitFreeplayError(socket, 'bad_payload', 'Invalid find payload')
      return
    }
    if (!requireAccount()) return
    const { game, mode, sector } = parsed.data

    // Already inside a live match of that game+mode+SECTOR? Re-send the
    // handshake instead of queueing a second time. Anything else (free play,
    // another sector, the other lobby mode, the other game) is left behind —
    // an Eclipse Slayer session must never be reused for Blitz LMS.
    const bound = bindings.get(socket.id)
    if (bound) {
      if (bound.game === game && bound.mode === mode && bound.sector === sector) {
        void bound.join(socket)
        return
      }
      bound.handleLeave(socket.id)
    }

    void findLobbyMatch(io, socket, game, mode, sector, bindings).catch((err) => {
      console.error('[freeplay] queue join failed:', err)
      emitFreeplayError(socket, 'join_failed', 'Matchmaking failed — try again')
    })
  })

  // C→S freeplay:cancel { game, mode?, sector? } — cancel/unmount/view change.
  socket.on('freeplay:cancel', (payload: unknown) => {
    const parsed = cancelSchema.safeParse(payload)
    if (!parsed.success) {
      // Cancelling must ALWAYS resolve the client's searching screen, even
      // on a malformed payload — drop every freeplay queue this socket has.
      cancelAllLobbyQueues(io, socket)
      return
    }
    cancelLobbyMatch(io, socket, parsed.data.game, parsed.data.mode, parsed.data.sector)
  })

  // C→S freeplay:input — direction/flags ONLY, never positions. The world
  // zod-parses per game (cells vs asteroids schemas) and clamps; routing is
  // by socket.id so a payload can't act on someone else's session.
  socket.on('freeplay:input', (payload: unknown) => {
    bindings.get(socket.id)?.handleInput(socket.id, payload)
  })

  // C→S freeplay:cashout_start — permanent world only (a lobby match has no
  // money and the world ignores it).
  socket.on('freeplay:cashout_start', (payload: unknown) => {
    if (!noPayloadSchema.safeParse(payload).success) return
    bindings.get(socket.id)?.handleCashoutStart(socket.id)
  })

  // C→S freeplay:cashout_cancel — releases the hold (no-op mid-payout).
  socket.on('freeplay:cashout_cancel', (payload: unknown) => {
    if (!noPayloadSchema.safeParse(payload).success) return
    bindings.get(socket.id)?.handleCashoutCancel(socket.id)
  })

  // C→S freeplay:leave — voluntary despawn (free play) / forfeit (lobby).
  // When the socket is only QUEUED, this is the cancel path.
  socket.on('freeplay:leave', (payload: unknown) => {
    if (!noPayloadSchema.safeParse(payload).success) return
    const bound = bindings.get(socket.id)
    if (bound) {
      bound.handleLeave(socket.id)
      return
    }
    cancelAllLobbyQueues(io, socket)
  })

  // Own disconnect cleanup (design: each register* module attaches its own
  // — no central loop). Permanent world: starts the 60 s grace window.
  // Lobby match: a forfeit, so the survivors get their result.
  // Queue slots are cleaned by queue.ts's own disconnect hook.
  socket.on('disconnect', () => {
    bindings.get(socket.id)?.handleDisconnect(socket.id)
  })
}

// ─────────────────────────────────────────────────
// Graceful shutdown (called from socket/index.ts on SIGINT/SIGTERM)
// ─────────────────────────────────────────────────

/**
 * Stop every world in parallel: permanent worlds auto-cash-out their
 * sessions (best-effort), live matches end with a scoreboard so no client
 * is left staring at a frozen canvas. Worlds still being CREATED at this
 * instant are skipped — they can't have players yet (join awaits creation).
 */
export async function shutdownFreeplay(): Promise<void> {
  const active = [...worlds.values(), ...activeMatchWorlds()]
  if (active.length === 0) return
  await Promise.all(
    active.map((world) =>
      world.shutdown().catch((err) => {
        console.error(`[freeplay] ${world.game}/${world.mode} shutdown failed:`, err)
      })
    )
  )
  console.log('[freeplay] all worlds stopped')
}
