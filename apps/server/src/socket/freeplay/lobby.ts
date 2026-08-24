/**
 * LOBBY MATCHES — the online 2×2 for cells and asteroids
 * =======================================================
 * free_play is the permanent world (index.ts) and is NOT queueable. Online
 * play is a 2×2 of SECTOR × MODE:
 *
 *   eclipse · slayer   eclipse · lms   blitz · slayer   blitz · lms
 *
 * You queue for exactly one of them, and when enough humans are waiting the
 * server spins up a MATCH-SCOPED world that runs the same simulation with a
 * waiting → running → ended lifecycle. No bots, ever, in any of them.
 *
 * QUEUE KEYING (the whole point of the sector work): the queue mode string is
 * `${sector}:${mode}` — `eclipse:slayer`, `eclipse:lms`, `blitz:slayer`,
 * `blitz:lms`. Four distinct queues, so an Eclipse Slayer player can NEVER be
 * matched into a Blitz LMS game. `queue:status.mode` carries that same string.
 *
 * DIFFICULTY: (sector, mode) is collapsed server-side into the practice
 * difficulty code (10/11/12/13) and handed to the world, so the server sim
 * and the clients run the identical zone rules. A client never picks it.
 *
 * Everything queue-shaped is delegated to the shared, never-silent
 * `socket/queue.ts` (the module that fixes "online refuses to search"):
 *   - every `freeplay:find` emits `queue:status`, duplicates included
 *   - `freeplay:cancel` / unmount / disconnect always emit inQueue:false
 *   - one slot per wallet per game, disconnect cleanup
 *   - SKILL-based pairing on the 'ffa' ladder (rankingLogic.md §5.3): the
 *     roster is the group with the smallest spread in hidden skill that
 *     everyone in it currently accepts, and the accepted spread widens with
 *     wait time so queue times never regress.
 *
 * RANKED: slayer and lms both settle on the shared 'ffa' rating ladder when
 * the match ends (world.ts → settleRanked). Free play does NOT — it is the
 * permanent world in index.ts and has no outcome to rate.
 *
 * NO MONEY: a lobby match never touches wagerService — its world is built
 * with `ledgerMatchId: null` and a zero entry fee.
 */

import type { Server, Socket } from 'socket.io'
import {
  joinQueue,
  leaveQueue,
  type QueueMatch,
} from '../queue'
import { AsteroidsWorld } from './asteroidsWorld'
import { CellsWorld } from './cellsWorld'
import {
  FREEPLAY_GAMES,
  LOBBY_MIN_PLAYERS,
  LOBBY_MAX_PLAYERS,
  difficultyFor,
  queueModeKey,
  type FreeplayGame,
  type FreeplaySector,
  type LobbyMode,
} from './types'
import type { FreeplayWorld } from './world'

/** matchId → live match world. Used for shutdown and for diagnostics. */
const matchWorlds = new Map<string, FreeplayWorld>()

/** What the queue carries from `freeplay:find` to `startMatch`. */
interface LobbyMeta {
  game: FreeplayGame
  mode: LobbyMode
  sector: FreeplaySector
}

/** Build the right world subclass for a match-scoped game. */
function createMatchWorld(
  game: FreeplayGame,
  mode: LobbyMode,
  sector: FreeplaySector,
  matchId: string,
  bindings: Map<string, FreeplayWorld>
): FreeplayWorld {
  const options = {
    mode,
    sector,
    // Derived HERE, from the queue's own (sector, mode) — never from a
    // client payload. This is the number the zone simulation keys off.
    difficulty: difficultyFor(sector, mode),
    matchId,
    ledgerMatchId: null, // lobby matches are money-free by contract
    entryFee: 0,
    bindings,
    onEnded: (world: FreeplayWorld) => {
      matchWorlds.delete(world.matchId)
      console.log(`[freeplay] ${game}/${sector}:${mode} match ${matchId} torn down`)
    },
  }
  return game === 'cells' ? new CellsWorld(options) : new AsteroidsWorld(options)
}

/**
 * Queue handoff: exactly `needed` connected players arrive here. Build the
 * world, put everyone in it, then start the countdown — `beginMatch()` is
 * what emits `freeplay:match_found` (with sector + difficulty) and flips the
 * lifecycle to 'running' once every client has had time to mount its canvas.
 *
 * Every player in `match.players` came out of the SAME `${sector}:${mode}`
 * queue, so reading the first one's meta describes all of them.
 */
async function startMatch(
  match: QueueMatch<LobbyMeta>,
  bindings: Map<string, FreeplayWorld>
): Promise<void> {
  const { game, mode, sector } = match.players[0]!.meta
  const world = createMatchWorld(game, mode, sector, match.matchId, bindings)
  matchWorlds.set(match.matchId, world)

  // Sequential joins: each one is cheap (no DB in lobby mode) and the
  // roster order stays deterministic.
  for (const socket of match.sockets) {
    await world.join(socket)
  }
  world.beginMatch()

  console.log(
    `[freeplay] ${game}/${sector}:${mode} (difficulty ${world.difficulty}) match ${match.matchId} started with ${match.sockets.length} players`
  )
}

/**
 * C→S `freeplay:find { game, mode, sector }` — enter (or re-enter) one of the
 * four queues. ALWAYS answers, duplicates included: joinQueue emits
 * `queue:status` on every call, so a second click can never freeze the UI.
 */
export async function findLobbyMatch(
  io: Server,
  socket: Socket,
  game: FreeplayGame,
  mode: LobbyMode,
  sector: FreeplaySector,
  bindings: Map<string, FreeplayWorld>
): Promise<void> {
  const queueMode = queueModeKey(sector, mode) // 'eclipse:slayer' etc.
  await joinQueue<LobbyMeta>({
    socket,
    io,
    game,
    mode: queueMode, // FOUR distinct queues — never cross-matched
    needed: LOBBY_MIN_PLAYERS, // contract: 2 so it is testable
    // 30-player lobbies: sweep every mutually-acceptable waiter into the
    // match (queue-side gather hold makes bursts coalesce; see queue.ts).
    maxPlayers: LOBBY_MAX_PLAYERS,
    // §5.3: pair on hidden skill from the 'ffa' pool — the SAME pool these
    // matches settle onto, and the same one quiz FFA uses. All four
    // sector×mode queues share it: a player's free-for-all skill does not
    // depend on which map or which win condition they picked.
    ladder: 'ffa',
    meta: { game, mode, sector },
    // A freeplay-flavoured echo next to queue:status, for clients that
    // prefer a game-specific event name.
    legacyAck: {
      event: 'freeplay:searching',
      payload: {
        game,
        mode,
        sector,
        queueMode,
        difficulty: difficultyFor(sector, mode),
      },
    },
    onMatch: (m) => startMatch(m, bindings),
  })
}

/**
 * C→S `freeplay:cancel` — cancel button, unmount, or a view change.
 *
 * A full (mode, sector) pair targets that one queue; anything less drops the
 * socket from EVERY queue of the game. That is always safe — a wallet only
 * ever holds one slot per game — and it guarantees a cancel can never leave a
 * client stranded on a searching screen because it named the wrong sector.
 */
export function cancelLobbyMatch(
  io: Server,
  socket: Socket,
  game: FreeplayGame,
  mode?: LobbyMode,
  sector?: FreeplaySector
): void {
  const queueMode = mode && sector ? queueModeKey(sector, mode) : undefined
  leaveQueue({ socket, io, game, mode: queueMode })
}

/**
 * Drop this socket from BOTH freeplay queues (cells + asteroids) and no
 * others — a stuck/ambiguous cancel must never evict the player from some
 * other game's queue. Always emits `queue:status { inQueue:false }`.
 */
export function cancelAllLobbyQueues(io: Server, socket: Socket): void {
  for (const game of FREEPLAY_GAMES) leaveQueue({ socket, io, game })
}

/** Every live match world (used by the graceful-shutdown path). */
export function activeMatchWorlds(): FreeplayWorld[] {
  return [...matchWorlds.values()]
}
