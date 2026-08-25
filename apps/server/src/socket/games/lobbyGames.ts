/**
 * IFRAME LOBBY GAMES — golf / clumsy / pugshooter matchmaking
 * ===========================================================
 * Neon Golf Clash, Neon Clumsy and Neon Pug Shooter are self-contained
 * <iframe> games: they own their whole simulation and, today, still fill every
 * opponent slot with LOCAL BOTS. This module deliberately does NOT try to sync
 * those simulations — it gives the three games the one thing they were missing:
 * a REAL queue, so "Online" means "wait for actual humans, then boot together
 * with the roster" instead of dropping straight into a bot match.
 *
 * Scope, stated plainly so nobody is misled by this file:
 *   ✅ real server-side matchmaking (shared socket/queue.ts)
 *   ✅ a match room + roster handed to every matched client
 *   ✅ leave / disconnect bookkeeping so nobody is stuck queued or ghosted
 *   ❌ NO in-iframe state sync — the round each player then plays is still the
 *      local single-player-with-bots simulation. Networking those games is a
 *      separate project; the roster handoff below is the hook it will use.
 *
 * NO MONEY: queueing and playing here are free. This module never touches
 * wagers, pots or NeonBucks — there is no stake on the online path at all.
 *
 * WIRE CONTRACT
 * -------------
 *   C→S  lobbyGame:find       { game, mode? }   — enter the queue (idempotent)
 *   C→S  lobbyGame:leave      { game }          — cancel / left the lobby view
 *   C→S  lobbyGame:leaveMatch { matchId? }      — left a running match
 *   C→S  lobbyGame:result     { matchId, score } — my round finished with
 *        this score. When every REMAINING roster member has reported, the
 *        match resolves: highest score wins (ties share it).
 *
 *   S→C  queue:status  { game, mode, inQueue, current, needed }   (queue.ts)
 *        …emitted on EVERY find, duplicates included — never silent.
 *   S→C  lobbyGame:start { game, mode, matchId, room, players[] } — per player,
 *        players = [{ id: socketId, name, you }] (names only, NEVER wallets).
 *   S→C  lobbyGame:playerLeft { game, matchId, name, remaining }
 *   S→C  lobbyGame:end { game, matchId, winners[], scores:[{name,score,you}] }
 *        — the SCORE DUEL verdict. ‼️ Scores are CLIENT-CLAIMED (each round
 *        still runs locally), so this settles NO RP and no money — it is a
 *        social verdict + the trigger for the results overlay. XP continues
 *        to flow through the capped POST /api/stats/session path only.
 *   S→C  gameAuthError { code:'no_account', message }             (queue.ts)
 *
 * Identity is always socket.data.wallet / socket.data.username — client
 * payloads are cosmetic and never trusted for identity.
 */

import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import { joinQueue, leaveQueue, type QueueMatch } from '../queue'

// ---------------------------------------------------------------------------
// Which games this module serves, and how many HUMANS each mode waits for
// ---------------------------------------------------------------------------

export type LobbyGameId = 'golf' | 'clumsy' | 'pugshooter'

/**
 * `game → mode → {needed, maxPlayers}` — the capacity contract:
 *   - golf classic and pugshooter duel are strict 1v1 (2/2);
 *   - clumsy and pugshooter ffa are FFA: matches START at 2 but the queue
 *     may sweep more waiting humans in (private parties arrive whole);
 *   - pugshooter duo is 2v2 and requires EXACTLY 4 — the queue forms
 *     nothing smaller, and the private room refuses to start under 4.
 * Empty seats beyond the humans are still bot-filled by the iframes.
 */
const LOBBY_GAME_MODES: Record<
  LobbyGameId,
  Record<string, { needed: number; maxPlayers: number; fillFirst?: boolean }>
> = {
  golf: { classic: { needed: 2, maxPlayers: 2 } },
  // FFA lobbies are FILL-FIRST: hold for a full house, majority-vote or the
  // 2-minute fallback starts early (queue.ts).
  clumsy: { classic: { needed: 2, maxPlayers: 12, fillFirst: true } },
  pugshooter: {
    // Per-map FFA capacities — the map IS part of the queue key:
    // Cold Storage (warehouse) seats 10, Neon Suburbs (city) seats 30.
    'ffa:city': { needed: 2, maxPlayers: 30, fillFirst: true },
    'ffa:warehouse': { needed: 2, maxPlayers: 10, fillFirst: true },
    duel: { needed: 2, maxPlayers: 2 },
    duo: { needed: 4, maxPlayers: 4 },
  },
}

/** Mode used when the client doesn't name one (golf + clumsy have only one). */
const DEFAULT_MODE: Record<LobbyGameId, string> = {
  golf: 'classic',
  clumsy: 'classic',
  pugshooter: 'ffa:city',
}

/** Legacy/loose mode names → canonical queue keys. */
const MODE_ALIASES: Record<string, string> = {
  // A bare 'ffa' (older clients, or a map-less payload) plays Neon Suburbs.
  ffa: 'ffa:city',
}

// ---------------------------------------------------------------------------
// Zod — every inbound payload is safeParse'd; bad shapes are ignored
// ---------------------------------------------------------------------------

const gameSchema = z.enum(['golf', 'clumsy', 'pugshooter'])

const findSchema = z.object({
  game: gameSchema,
  // Cosmetic hint only: the player count ALWAYS comes from the table above.
  mode: z.string().min(1).max(32).optional(),
})

const leaveSchema = z.object({ game: gameSchema })

const leaveMatchSchema = z.object({
  matchId: z.string().min(1).max(64).optional(),
})

const resultSchema = z.object({
  matchId: z.string().min(1).max(64),
  score: z.number().finite().min(0).max(1_000_000_000),
})

// ---------------------------------------------------------------------------
// Match bookkeeping (in-memory, one process — same convention as chess/connect)
// ---------------------------------------------------------------------------

interface LobbyRosterEntry {
  socketId: string
  /** socket.data.username — the canonical display name. */
  name: string
}

interface LobbyMatch {
  game: LobbyGameId
  mode: string
  matchId: string
  room: string
  players: LobbyRosterEntry[]
  /** socketId → reported score. Resolves when every roster member has one. */
  scores: Map<string, number>
  /** Members who reported and THEN left — their scores still count. The
   *  unsynced rounds finish minutes apart, so finishing first and going back
   *  to the lobby is normal, not a forfeit. */
  finishers: Array<{ name: string; score: number; socketId: string }>
  /** The verdict is emitted exactly once. */
  resolved: boolean
}

/** matchId → match. */
const matches = new Map<string, LobbyMatch>()
/** socket.id → matchId (O(1) lookup on leave/disconnect). */
const matchBySocket = new Map<string, string>()

/** Normalise a requested mode to one this game actually offers. */
function resolveMode(game: LobbyGameId, requested?: string): string {
  const modes = LOBBY_GAME_MODES[game]
  const canonical = requested ? (MODE_ALIASES[requested] ?? requested) : undefined
  return canonical && canonical in modes ? canonical : DEFAULT_MODE[game]
}

/**
 * Build the match, join everyone to its room and tell each player who they are
 * playing with. Per-socket emits so each client can flag its own row (`you`).
 */
function startLobbyMatch(match: QueueMatch): void {
  const game = match.game as LobbyGameId
  const roster: LobbyRosterEntry[] = match.players.map((p) => ({
    socketId: p.socketId,
    name: p.username,
  }))

  const record: LobbyMatch = {
    game,
    mode: match.mode,
    matchId: match.matchId,
    room: match.room,
    players: roster,
    scores: new Map(),
    finishers: [],
    resolved: false,
  }
  matches.set(match.matchId, record)
  for (const entry of roster) matchBySocket.set(entry.socketId, match.matchId)

  for (const socket of match.sockets) {
    socket.emit('lobbyGame:start', {
      game,
      mode: match.mode,
      matchId: match.matchId,
      room: match.room,
      // Names only — wallets stay server-side bookkeeping.
      players: roster.map((entry) => ({
        id: entry.socketId,
        name: entry.name,
        you: entry.socketId === socket.id,
      })),
    })
  }

  console.log(
    `[lobbyGames] ${game}/${match.mode} match ${match.matchId} started with ${roster.length} players`
  )
}

/**
 * Re-send `lobbyGame:start` for a match this socket is ALREADY in, shaped
 * exactly like the original (per-socket, so `you` is right). Used when a
 * client asks to find a match it is already playing — a remount, or the
 * private-wager start where the server queued on the player's behalf and the
 * lobby screen then queued again.
 */
function resendLobbyStart(socket: Socket, match: LobbyMatch): void {
  socket.emit('lobbyGame:start', {
    game: match.game,
    mode: match.mode,
    matchId: match.matchId,
    room: match.room,
    // Names only — wallets stay server-side bookkeeping.
    players: match.players.map((entry) => ({
      id: entry.socketId,
      name: entry.name,
      you: entry.socketId === socket.id,
    })),
  })
}

/**
 * SCORE-DUEL verdict: once every remaining roster member has a score, rank
 * them and tell the room. Highest score wins; ties share the win. Client-
 * claimed scores NEVER touch RP (design contract) — this is a social verdict
 * only, XP stays on the capped session path.
 */
function maybeResolve(io: Server, match: LobbyMatch): void {
  if (match.resolved) return
  if (match.players.length + match.finishers.length < 1) return
  if (!match.players.every((p) => match.scores.has(p.socketId))) return
  match.resolved = true

  // The board = everyone still seated + everyone who reported then left.
  const rows = [
    ...match.players.map((p) => ({
      socketId: p.socketId,
      name: p.name,
      score: match.scores.get(p.socketId) ?? 0,
    })),
    ...match.finishers,
  ].sort((a, b) => b.score - a.score)
  const top = rows[0]?.score ?? 0
  const winners = rows.filter((r) => r.score === top).map((r) => r.name)

  for (const r of rows) {
    io.sockets.sockets.get(r.socketId)?.emit('lobbyGame:end', {
      game: match.game,
      matchId: match.matchId,
      winners,
      scores: rows.map((row) => ({ name: row.name, score: row.score, you: row.socketId === r.socketId })),
    })
  }
  // The record stays until everyone leaves (releaseMatch) so a late
  // lobbyGame:find remount can still resendLobbyStart the roster.
}

/**
 * Take a socket out of whatever match it belongs to and tell the survivors.
 * Idempotent: a socket with no match is a no-op.
 */
function releaseMatch(io: Server, socket: Socket): void {
  const matchId = matchBySocket.get(socket.id)
  if (!matchId) return
  matchBySocket.delete(socket.id)

  const match = matches.get(matchId)
  if (!match) return

  const leaver = match.players.find((p) => p.socketId === socket.id)
  match.players = match.players.filter((p) => p.socketId !== socket.id)
  socket.leave(match.room)

  // Finished-then-left is NOT a forfeit: the reported score stays on the
  // board (the leaver just gets the verdict from wherever they are — the
  // per-socket emit in maybeResolve still reaches a connected socket).
  if (leaver && match.scores.has(socket.id) && !match.resolved) {
    match.finishers.push({
      name: leaver.name,
      score: match.scores.get(socket.id)!,
      socketId: socket.id,
    })
  }

  if (match.players.length === 0) {
    // Everyone has left the seats. If some of them reported, resolve the
    // duel among the finishers before the record goes away.
    maybeResolve(io, match)
    matches.delete(matchId)
    return
  }

  io.to(match.room).emit('lobbyGame:playerLeft', {
    game: match.game,
    matchId,
    name: leaver?.name ?? 'A player',
    remaining: match.players.length,
  })

  // A leaver forfeits: if everyone still in has reported, resolve now.
  maybeResolve(io, match)
}

// ---------------------------------------------------------------------------
// registerLobbyGames — wires all events + this module's OWN disconnect cleanup
// ---------------------------------------------------------------------------

export function registerLobbyGames(io: Server, socket: Socket): void {
  // ------------------------------------------------------- lobbyGame:find
  socket.on('lobbyGame:find', (payload: unknown) => {
    const parsed = findSchema.safeParse(payload ?? {})
    if (!parsed.success) return

    const game = parsed.data.game
    const mode = resolveMode(game, parsed.data.mode)
    const { needed, maxPlayers, fillFirst } = LOBBY_GAME_MODES[game][mode]!

    // ALREADY IN A LIVE MATCH OF THIS GAME+MODE? Re-send the handshake rather
    // than tearing it down and queueing again.
    //
    // The private-wager start (socket/games/privateMatch.ts) dispatches
    // `lobbyGame:find` on the player's behalf, and the lobby screen the client
    // mounts a moment later sends its OWN — so without this, every private
    // Golf / Clumsy / Pug Shooter room abandoned the match it had just made
    // and built a second one. Chess, Connect, Trivia and the freeplay worlds
    // all guard this the same way.
    //
    // A find for a DIFFERENT game/mode still means "I walked away", so that
    // path keeps releasing the old match below.
    const currentMatchId = matchBySocket.get(socket.id)
    const current = currentMatchId ? matches.get(currentMatchId) : undefined
    if (current && !current.resolved && current.game === game && current.mode === mode) {
      resendLobbyStart(socket, current)
      return
    }

    // Re-queueing while already in a match means the player walked away from
    // it (the shared socket stays up when they navigate back to the lobby).
    releaseMatch(io, socket)

    // joinQueue ALWAYS answers with queue:status — including on a duplicate
    // click — so the client's optimistic searching screen can never be left
    // hanging on server silence. No legacy ack: these games are new online.
    void joinQueue({
      socket,
      io,
      game,
      mode,
      needed,
      maxPlayers,
      fillFirst: fillFirst === true,
      onMatch: startLobbyMatch,
    })
  })

  // ----------------------------------------------------- lobbyGame:result
  socket.on('lobbyGame:result', (payload: unknown) => {
    const parsed = resultSchema.safeParse(payload)
    if (!parsed.success) return
    const match = matches.get(parsed.data.matchId)
    if (!match || match.resolved) return
    // Roster members only, first report wins (no score revisions).
    if (!match.players.some((p) => p.socketId === socket.id)) return
    if (match.scores.has(socket.id)) return
    match.scores.set(socket.id, parsed.data.score)
    maybeResolve(io, match)
  })

  // ------------------------------------------------------ lobbyGame:leave
  // Cancel button, unmount, or the player navigating away from the lobby.
  socket.on('lobbyGame:leave', (payload: unknown) => {
    const parsed = leaveSchema.safeParse(payload ?? {})
    if (!parsed.success) return
    // No mode → leaves every mode of this game (a client can only hold one).
    leaveQueue({ socket, io, game: parsed.data.game })
  })

  // ------------------------------------------------- lobbyGame:leaveMatch
  // The player quit a started match back to the lobby.
  socket.on('lobbyGame:leaveMatch', (payload: unknown) => {
    // matchId is advisory — the server trusts its own socket→match index.
    if (!leaveMatchSchema.safeParse(payload ?? {}).success) return
    releaseMatch(io, socket)
  })

  // ----------------------------------------------------------- disconnect
  // Per-module cleanup (design contract: no central disconnect loop). Queue
  // entries are cleaned up by queue.ts's own disconnect hook.
  socket.on('disconnect', () => {
    releaseMatch(io, socket)
  })
}

// ---------------------------------------------------------------------------
// Read-only helpers (ops / debugging)
// ---------------------------------------------------------------------------

/** Live matches for a game (or all of them) — debugging only. */
export function lobbyMatchSnapshot(game?: LobbyGameId): LobbyMatch[] {
  const out: LobbyMatch[] = []
  for (const match of matches.values()) {
    if (game && match.game !== game) continue
    out.push(match)
  }
  return out
}
