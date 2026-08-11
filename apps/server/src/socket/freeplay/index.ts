/**
 * FREE PLAY ENTRY POINT — registerFreeplay(io, socket) + shutdownFreeplay()
 * =========================================================================
 * The socket-facing edge of the permanent worlds:
 *
 * - World SINGLETONS, one per (game, REGION). This process serves exactly
 *   one region (config.REGION — money doc §5: regions are separate server
 *   instances, not a column on a shared world), so the map is keyed by
 *   game alone; the region lives on the permanent matches row.
 * - Worlds are created LAZILY on first join: ensureFreeplayMatch finds or
 *   creates the never-settling matches row, then the world starts its
 *   forever-tick. No DB → no world → `freeplay:error { code:'no_db' }`
 *   (the contract: free play refuses to run without a ledger).
 * - Event routing: every C→S payload is zod-validated (schemas in
 *   types.ts / inside the worlds); sockets are routed to their world via
 *   the shared `bindings` map that the worlds keep up to date.
 * - shutdownFreeplay(): auto-cash-out of every active player across all
 *   worlds — socket/index.ts calls this on SIGINT/SIGTERM (§7: treat
 *   graceful shutdown as a first-class code path).
 */

import type { Server, Socket } from 'socket.io'
import { config } from '../../config/env'
import { ensureFreeplayMatch } from '../../services/wagerService'
import {
  emitFreeplayError,
  joinSchema,
  noPayloadSchema,
  type FreeplayGame,
} from './types'
import type { FreeplayWorld } from './world'
import { CellsWorld } from './cellsWorld'
import { AsteroidsWorld } from './asteroidsWorld'

// ─────────────────────────────────────────────────
// World singletons (lazy, one per game for THIS region)
// ─────────────────────────────────────────────────

/** game → live world. Populated on first successful join. */
const worlds = new Map<FreeplayGame, FreeplayWorld>()

/** game → in-flight creation, so concurrent first-joins share one attempt
 *  instead of racing ensureFreeplayMatch. A FAILED attempt is not cached —
 *  the next join retries (the DB may have come up in the meantime). */
const pendingWorlds = new Map<FreeplayGame, Promise<FreeplayWorld | null>>()

/** socket.id → the world that socket is playing in. Shared with the World
 *  instances (constructor arg) so a despawn that originates INSIDE a tick
 *  (cash-out, elimination, grace timeout) releases the route itself. */
const bindings = new Map<string, FreeplayWorld>()

/** Find-or-lazily-create the world for `game`. Null = no database. */
async function getWorld(game: FreeplayGame): Promise<FreeplayWorld | null> {
  const existing = worlds.get(game)
  if (existing) return existing

  let pending = pendingWorlds.get(game)
  if (!pending) {
    pending = (async (): Promise<FreeplayWorld | null> => {
      // The permanent matches row for (game, REGION) — created once,
      // status 'active' forever, never settles (design contract).
      const match = await ensureFreeplayMatch(game, config.REGION)
      if (!match) return null // no db (or db error) — caller emits no_db

      // Entry fee comes from the match row snapshot so every instance of
      // this region agrees, even if the env default changes later.
      const entryFee = Number(match.betAmount ?? config.FREEPLAY_ENTRY_FEE)

      const world: FreeplayWorld =
        game === 'cells'
          ? new CellsWorld(match.id, entryFee, bindings)
          : new AsteroidsWorld(match.id, entryFee, bindings)
      worlds.set(game, world)
      console.log(
        `[freeplay] ${game} world started (region=${config.REGION}, match=${match.id})`
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
  void io // room broadcasts aren't used — worlds emit per-socket (interest mgmt)

  // C→S freeplay:join { game } — region is NOT a payload field; this
  // server IS a region.
  socket.on('freeplay:join', (payload: unknown) => {
    const parsed = joinSchema.safeParse(payload)
    if (!parsed.success) {
      emitFreeplayError(socket, 'bad_payload', 'Invalid join payload')
      return
    }

    // Free play is a wagered mode — it REQUIRES a registered account,
    // same rule (and same event) as every other game's matchmaking entry.
    if (!socket.data.username) {
      socket.emit('gameAuthError', {
        code: 'no_account',
        message: 'Finish account setup to play online',
      })
      return
    }

    // Already routed to a world on this socket? Same game → treat as a
    // resume (the world rebinds idempotently); different game → refuse
    // (one live session per socket, mirroring Pattern 5's per-wallet rule).
    const bound = bindings.get(socket.id)
    if (bound && bound.game !== parsed.data.game) {
      emitFreeplayError(
        socket,
        'already_active',
        `Already in the ${bound.game} world — leave it first`
      )
      return
    }

    void (async () => {
      try {
        const world = await getWorld(parsed.data.game)
        if (!world) {
          emitFreeplayError(socket, 'no_db', 'Wager ledger unavailable — free play is closed')
          return
        }
        await world.join(socket)
      } catch (err) {
        console.error('[freeplay] join dispatch failed:', err)
        emitFreeplayError(socket, 'join_failed', 'Join failed — try again')
      }
    })()
  })

  // C→S freeplay:input — direction/flags ONLY, never positions. The world
  // zod-parses per game (cells vs asteroids schemas) and clamps; routing
  // is by socket.id so a payload can't act on someone else's session.
  socket.on('freeplay:input', (payload: unknown) => {
    bindings.get(socket.id)?.handleInput(socket.id, payload)
  })

  // C→S freeplay:cashout_start — begins the SERVER-enforced 3 s hold (the
  // client's own hold timer is cosmetic; the world's clock decides).
  socket.on('freeplay:cashout_start', (payload: unknown) => {
    if (!noPayloadSchema.safeParse(payload).success) return
    bindings.get(socket.id)?.handleCashoutStart(socket.id)
  })

  // C→S freeplay:cashout_cancel — releases the hold (no-op mid-payout).
  socket.on('freeplay:cashout_cancel', (payload: unknown) => {
    if (!noPayloadSchema.safeParse(payload).success) return
    bindings.get(socket.id)?.handleCashoutCancel(socket.id)
  })

  // C→S freeplay:leave — voluntary despawn + auto-cash-out at current pot.
  socket.on('freeplay:leave', (payload: unknown) => {
    if (!noPayloadSchema.safeParse(payload).success) return
    bindings.get(socket.id)?.handleLeave(socket.id)
  })

  // Own disconnect cleanup (design: each register* module attaches its own
  // — no central loop). Starts the 60 s grace window; the body stays
  // killable, a reconnect resumes, the timeout auto-cashes-out.
  socket.on('disconnect', () => {
    bindings.get(socket.id)?.handleDisconnect(socket.id)
  })
}

// ─────────────────────────────────────────────────
// Graceful shutdown (called from socket/index.ts on SIGINT/SIGTERM)
// ─────────────────────────────────────────────────

/**
 * Auto-cash-out every active player in every world, in parallel. Worlds
 * still being CREATED at this instant are skipped — they can't have
 * players yet (join awaits creation), so there is nothing to cash out.
 */
export async function shutdownFreeplay(): Promise<void> {
  const active = [...worlds.values()]
  if (active.length === 0) return
  await Promise.all(
    active.map((world) =>
      world.shutdown().catch((err) => {
        console.error(`[freeplay] ${world.game} shutdown failed:`, err)
      })
    )
  )
  console.log('[freeplay] all worlds cashed out and stopped')
}
