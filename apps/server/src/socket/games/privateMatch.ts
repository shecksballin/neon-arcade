/**
 * PRIVATE WAGER ROOMS — registerPrivateMatch(io, socket)
 * ======================================================
 * "Private Wager" is a NAME ONLY (the platform is money-free this pass): a
 * private room is an invite-only waiting room that starts a NORMAL match
 * between friends instead of pairing them with strangers.
 *
 * WIRE CONTRACT (design contract → SOCKETS → PRIVATE WAGER)
 * --------------------------------------------------------
 *   C→S  private:create { gameKey, mode }
 *   C→S  private:invite  { roomId, username }     — accepted FRIENDS only
 *   C→S  private:join    { roomId }               — validated against invites
 *   C→S  private:decline { roomId }               — drop MY invite to that room
 *   C→S  private:ready   { roomId, ready }
 *   C→S  private:leave   { roomId }               — host leaving closes it
 *
 *   S→C  private:room      { roomId, gameKey, mode, capacity, status,
 *                            host:{username}, players:[{username, ready, isHost}] }
 *   S→C  private:invited   { roomId, fromUsername, gameKey, mode, expiresIn }
 *                          — sent on invite AND replayed to a fresh socket for
 *                            every live invite addressed to it (a reload must
 *                            not lose an invitation that is still good).
 *                            `expiresIn` is the MS REMAINING on the server's
 *                            own timer, so a replay cannot restart the client's
 *                            clock and clock skew cannot bin a live invite.
 *   S→C  private:countdown { seconds }            — all ready AND ≥2 players
 *   S→C  private:started   { roomId, gameKey, mode }  — the room is done; the
 *                            game's OWN start event lands in the same tick
 *   S→C  private:closed    { roomId, reason }     — host left / empty / expired /
 *                            started. Sent to the room channel AND to every
 *                            wallet holding an unaccepted invite, which is in
 *                            no channel (see notifyInvitesClosed).
 *   S→C  private:error     { code, message, roomId? }  — `roomId` whenever the
 *                            refusal is ABOUT a room, so a client with more
 *                            than one private-wager surface open can tell
 *                            whose refusal it just received
 *
 * ‼️ SECURITY
 * -----------
 * - Identity is ALWAYS `socket.data.wallet` from the handshake JWT; a payload
 *   never names its own actor.
 * - Payloads carry USERNAMES ONLY. Wallets are the internal room key and are
 *   never serialized. `roomId` is a random uuid that maps to nothing.
 * - Invites require an ACCEPTED friendship in BOTH directions of the check
 *   (social.ts `areFriends`, which fails closed). Every invite failure that
 *   could reveal whether a username exists returns ONE generic code.
 * - Every payload is zod-parsed; invites are rate limited per wallet.
 *
 * HOW A PRIVATE MATCH ACTUALLY STARTS (read this before changing it)
 * ------------------------------------------------------------------
 * The room does NOT re-implement any game. When everyone is ready it drives
 * each player's OWN matchmaking entry point — the exact same C→S event the
 * public "Wager Match" button sends (`findGame`, `findVolleyGame`,
 * `neonconnect_join`, `findTriviaGame`, `freeplay:find`, `lobbyGame:find`) —
 * for every member in the SAME tick. The game module then builds its own
 * state and emits its own start event (`gameStart`, `volleyGameStart`,
 * `neonconnect_match`, `triviaGameStart`, `freeplay:match_found`,
 * `lobbyGame:start`), so every line of in-match code, ELO settlement and
 * stats recording works completely unchanged.
 *
 * KNOWN LIMITATION (deliberate, documented): those matchmaking queues are the
 * PUBLIC ones. If a stranger is already waiting in the same game+mode queue at
 * that instant, FIFO can hand them one of the private players. Making this
 * airtight needs a `startPrivateMatch()` export inside each game module, which
 * is out of scope for this file's ownership — see the report.
 */

import { randomUUID } from 'node:crypto'
import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import { createRateLimiter } from '../../lib/rateLimit'
import {
  areFriends,
  pushToWallet,
  resolveUsernameToWallet,
  usernameSchema,
} from '../social'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Invites die after 5 minutes (design contract). */
const INVITE_TTL_MS = 5 * 60_000

/** A room nobody ever started is swept after this long. */
const ROOM_TTL_MS = 60 * 60_000

/** Housekeeping cadence for expired invites / abandoned rooms. */
const SWEEP_INTERVAL_MS = 60_000

/** Countdown between "everyone ready" and the real match start. */
const COUNTDOWN_SECONDS = 3
const COUNTDOWN_MS = COUNTDOWN_SECONDS * 1000

/** A private match still needs two humans — same floor as every public mode. */
const MIN_PLAYERS = 2

/** Per-wallet budgets (design contract: invites 20/min). */
const inviteLimiter = createRateLimiter(60_000, 20)
const createLimiter = createRateLimiter(60_000, 20)
/** Join/ready/leave are cheap but broadcast — keep them from becoming a flood. */
const actionLimiter = createRateLimiter(60_000, 120)

// ---------------------------------------------------------------------------
// GAME CATALOG — every game/mode a private room can host, and the PUBLIC
// matchmaking event that starts it. Free play (cells/asteroids) is absent on
// purpose: the contract excludes it from private wager (it is a permanent
// drop-in world with no match to start).
//
// `capacity` mirrors what the public path actually seats today:
//   - the shared queue (socket/queue.ts) starts golf/clumsy/pugshooter and
//     cells/asteroids slayer+lms at TWO humans, so a 3rd private player
//     would be split into a second match — hence capacity 2 there as well.
//   - trivia FFA seats a whole lobby, so it allows more.
// ---------------------------------------------------------------------------

interface GameModeSpec {
  /** Max players the private room seats. */
  capacity: number
  /** The C→S matchmaking event the shipped client already sends. */
  findEvent: string
  /** Payload mirroring what that client sends (identity is never in it). */
  findPayload: (mode: string) => unknown
  /** The S→C start event the players will receive — documentation only. */
  startEvent: string
}

/** volley: one queue per regulation; the client sends `matchMode`. */
function volleyMode(matchMode: string): GameModeSpec {
  return {
    capacity: 2,
    findEvent: 'findVolleyGame',
    findPayload: () => ({ matchMode }),
    startEvent: 'volleyGameStart',
  }
}

/**
 * cells/asteroids: the freeplay lobby queue, one entry per SECTOR × MODE.
 * Free play is deliberately absent — it is not a queueable mode any more
 * (the server's `findSchema` rejects it outright).
 *
 * The room's mode id is the SAME string the queue uses (`eclipse:slayer`),
 * so there is exactly one wire vocabulary for the 2×2 to remember.
 */
function freeplayMode(
  game: string,
  sector: 'eclipse' | 'blitz',
  mode: 'slayer' | 'lms'
): GameModeSpec {
  return {
    capacity: 2,
    findEvent: 'freeplay:find',
    // `sector` is REQUIRED by findSchema; the server derives the practice
    // difficulty code (10/11/12/13) from it — never sent from here.
    findPayload: () => ({ game, mode, sector }),
    startEvent: 'freeplay:match_found',
  }
}

/** golf / clumsy / pugshooter: the iframe roster handoff queue. */
function lobbyMode(game: string): GameModeSpec {
  return {
    capacity: 2,
    findEvent: 'lobbyGame:find',
    findPayload: (mode: string) => ({ game, mode }),
    startEvent: 'lobbyGame:start',
  }
}

const CATALOG: Record<string, Record<string, GameModeSpec>> = {
  // ── 1v1 board/arcade games ────────────────────────────────────────────
  chess: {
    '1v1': {
      capacity: 2,
      findEvent: 'findGame',
      findPayload: () => ({}),
      startEvent: 'gameStart',
    },
  },
  connect: {
    '1v1': {
      capacity: 2,
      findEvent: 'neonconnect_join',
      findPayload: () => ({ profile: null }),
      startEvent: 'neonconnect_match',
    },
  },
  kickoff: {
    '1v1': {
      capacity: 2,
      findEvent: 'kickoff_find',
      findPayload: () => ({}),
      startEvent: 'kickoff_match',
    },
  },
  volley: {
    classic: volleyMode('classic'),
    bestof3: volleyMode('bestof3'),
    sudden: volleyMode('sudden'),
  },

  // ── world games: the SAME 2×2 the public online lobby offers ──────────
  // (free_play is NOT offered — contract. The bare 'slayer'/'lms' keys are
  // transitional aliases for clients that have not shipped the sector picker
  // yet; they resolve to ECLIPSE and can be deleted once nothing sends them.)
  cells: {
    'eclipse:slayer': freeplayMode('cells', 'eclipse', 'slayer'),
    'eclipse:lms': freeplayMode('cells', 'eclipse', 'lms'),
    'blitz:slayer': freeplayMode('cells', 'blitz', 'slayer'),
    'blitz:lms': freeplayMode('cells', 'blitz', 'lms'),
    slayer: freeplayMode('cells', 'eclipse', 'slayer'),
    lms: freeplayMode('cells', 'eclipse', 'lms'),
  },
  asteroids: {
    'eclipse:slayer': freeplayMode('asteroids', 'eclipse', 'slayer'),
    'eclipse:lms': freeplayMode('asteroids', 'eclipse', 'lms'),
    'blitz:slayer': freeplayMode('asteroids', 'blitz', 'slayer'),
    'blitz:lms': freeplayMode('asteroids', 'blitz', 'lms'),
    slayer: freeplayMode('asteroids', 'eclipse', 'slayer'),
    lms: freeplayMode('asteroids', 'eclipse', 'lms'),
  },

  // ── iframe lobby games ────────────────────────────────────────────────
  golf: { classic: lobbyMode('golf') },
  clumsy: { classic: lobbyMode('clumsy') },
  pugshooter: {
    ffa: lobbyMode('pugshooter'),
    duel: lobbyMode('pugshooter'),
    duo: lobbyMode('pugshooter'),
  },
}

/** The game keys a room may name — anything else is rejected by zod. */
const GAME_KEYS = [
  'chess',
  'connect',
  'volley',
  'kickoff',
  'cells',
  'asteroids',
  'golf',
  'clumsy',
  'pugshooter',
] as const

// ---------------------------------------------------------------------------
// Zod — EVERY inbound payload (global rule). Bad shapes are answered with one
// generic bad_payload error so a client is never left guessing.
// ---------------------------------------------------------------------------

const createSchema = z.object({
  gameKey: z.enum(GAME_KEYS),
  mode: z.string().min(1).max(24),
  /**
   * OPEN rooms skip the invite check on join: ANY signed-in player who knows
   * the roomId may take the free seat. The only thing that hands a roomId to
   * strangers is the community board's challenge feed (routes/community.ts),
   * which also verifies the poster owns the room — so "open" is exactly
   * "posted as a public challenge". Ordinary rooms stay invite-only.
   */
  open: z.boolean().optional(),
})

const inviteSchema = z.object({
  roomId: z.string().uuid(),
  username: usernameSchema,
})

const roomIdSchema = z.object({ roomId: z.string().uuid() })

const readySchema = z.object({
  roomId: z.string().uuid(),
  ready: z.boolean(),
})

// ---------------------------------------------------------------------------
// Room state (in-memory, one process — same convention as the game modules)
// ---------------------------------------------------------------------------

interface RoomMember {
  /** Live socket of this member. Rebound if they rejoin from a new tab. */
  socketId: string
  /** SERVER-SIDE ONLY — never serialized into a payload. */
  wallet: string
  username: string
  ready: boolean
}

interface RoomInvite {
  /** SERVER-SIDE ONLY. */
  wallet: string
  username: string
  fromUsername: string
  expiresAt: number
}

interface PrivateRoom {
  roomId: string
  gameKey: string
  mode: string
  spec: GameModeSpec
  /** SERVER-SIDE ONLY — decides who can close the room. */
  hostWallet: string
  hostUsername: string
  /** Ordered; the host is players[0] until they leave (which closes it). */
  players: RoomMember[]
  /** invitee wallet → invite. Expiry is checked on join AND swept. */
  invites: Map<string, RoomInvite>
  /** Public-challenge room: join needs no invite (see createSchema.open). */
  open: boolean
  status: 'open' | 'starting' | 'closed'
  countdownTimer: ReturnType<typeof setTimeout> | null
  createdAt: number
}

/** roomId → room. */
const rooms = new Map<string, PrivateRoom>()

/**
 * What the community board may say about a challenge's room. In-memory on
 * purpose: rooms live and die with this process, so the feed asks at read
 * time instead of persisting state that would go stale.
 *   'open'  — a stranger can still take the seat
 *   'full'  — seats taken or the countdown is running
 *   'gone'  — closed, never existed, or not an open room at all
 */
export function challengeRoomState(roomId: string): 'open' | 'full' | 'gone' {
  const room = rooms.get(roomId)
  if (!room || room.status === 'closed' || !room.open) return 'gone'
  if (room.status !== 'open' || room.players.length >= room.spec.capacity) return 'full'
  return 'open'
}

/** Ownership check for posting: only the HOST of a live open room may
 *  advertise it as a challenge (stops posts pointing at someone else's room),
 *  and the advertised game/mode must be the ROOM'S game/mode — without that
 *  pin a chess room could be posted as "golf", and the victim who joins gets
 *  started into a ranked chess match their client isn't even listening for
 *  (an RP-theft vector via the forfeit funnel). */
export function ownsOpenRoom(
  roomId: string,
  wallet: string,
  gameKey: string,
  mode: string
): boolean {
  const room = rooms.get(roomId)
  return (
    !!room &&
    room.open &&
    room.status === 'open' &&
    room.hostWallet === wallet &&
    room.gameKey === gameKey &&
    room.mode === mode
  )
}
/** socket.id → roomId (O(1) leave/disconnect lookups). */
const roomBySocket = new Map<string, string>()

/** socket.io room name for a private room. */
const channelOf = (room: PrivateRoom) => `private-${room.roomId}`

// ---------------------------------------------------------------------------
// Payload builders — usernames ONLY
// ---------------------------------------------------------------------------

function roomPayload(room: PrivateRoom) {
  return {
    roomId: room.roomId,
    gameKey: room.gameKey,
    mode: room.mode,
    capacity: room.spec.capacity,
    status: room.status,
    host: { username: room.hostUsername },
    players: room.players.map((member) => ({
      username: member.username,
      ready: member.ready,
      isHost: member.wallet === room.hostWallet,
    })),
  }
}

function broadcastRoom(io: Server, room: PrivateRoom): void {
  io.to(channelOf(room)).emit('private:room', roomPayload(room))
}

/**
 * Everything an invitee needs to render — and to TIME OUT — one invite card.
 *
 * `expiresIn` is HOW LONG THIS INVITE HAS LEFT, in ms, and the client is
 * expected to add it to its own clock. Two things make that the right shape:
 *
 *  - The client cannot compute it. Invites are REPLAYED to a fresh socket (see
 *    the replay block in registerPrivateMatch), so a reconnect delivers an
 *    invitation already partway through its life. A client stamping its own
 *    `now + 5 minutes` would restart a clock the server measures from the
 *    ORIGINAL invite, and go on offering a JOIN for minutes after the server
 *    had swept the invite away.
 *  - A duration is immune to clock skew, where an absolute deadline is not: a
 *    browser whose clock runs a few minutes fast would read a perfectly good
 *    `expiresAt` as already in the past and bin a live invitation on arrival.
 *
 * Never negative — the callers only ever send live invites, and clamping keeps
 * a scheduling hiccup from producing a card that is born expired.
 */
function invitedPayload(room: PrivateRoom, invite: RoomInvite) {
  return {
    roomId: room.roomId,
    fromUsername: invite.fromUsername,
    gameKey: room.gameKey,
    mode: room.mode,
    expiresIn: Math.max(0, invite.expiresAt - Date.now()),
  }
}

/**
 * Tell every INVITED-but-not-yet-joined wallet that a room is over.
 *
 * `private:closed` otherwise goes only to the socket.io channel, which holds
 * players who actually JOINED. An invitee was reached by `pushToWallet` and is
 * in no channel — so without this their invite card (the nav-bar bell, the
 * pop-up, and the JOIN button on that friend's row) outlives the room by up to
 * the full five-minute TTL, and pressing JOIN can only ever earn them a
 * `not_found`.
 */
function notifyInvitesClosed(room: PrivateRoom, reason: string): void {
  const now = Date.now()
  for (const invite of room.invites.values()) {
    if (invite.expiresAt <= now) continue
    if (memberOf(room, invite.wallet)) continue // already told via the channel
    pushToWallet(invite.wallet, 'private:closed', {
      roomId: room.roomId,
      reason,
    })
  }
}

/**
 * One shape for every refusal so no emitter drifts on field names.
 *
 * `roomId` is included whenever the refusal is ABOUT a specific room. The
 * socket is shared by every private-wager surface at once — a lobby's own
 * waiting room and the app-level host can both be listening — and without it a
 * client cannot tell whose refusal it just received, so one component's error
 * would surface on another's screen.
 */
function emitError(
  socket: Socket,
  code: string,
  message: string,
  roomId?: string
): void {
  socket.emit('private:error', roomId ? { code, message, roomId } : { code, message })
}

// ---------------------------------------------------------------------------
// Room lifecycle helpers
// ---------------------------------------------------------------------------

function memberOf(room: PrivateRoom, wallet: string): RoomMember | undefined {
  return room.players.find((member) => member.wallet === wallet)
}

/** Stop a pending countdown (composition changed under it). */
function clearCountdown(room: PrivateRoom): void {
  if (!room.countdownTimer) return
  clearTimeout(room.countdownTimer)
  room.countdownTimer = null
}

/**
 * Forget a room: unbind every socket index, pull the sockets out of the
 * channel and drop it from the registry. Emits nothing — callers announce
 * first (private:closed / private:started) while everyone is still in it.
 */
function destroyRoom(io: Server, room: PrivateRoom): void {
  clearCountdown(room)
  room.status = 'closed'
  for (const member of room.players) {
    if (roomBySocket.get(member.socketId) === room.roomId) {
      roomBySocket.delete(member.socketId)
    }
    io.sockets.sockets.get(member.socketId)?.leave(channelOf(room))
  }
  room.players = []
  rooms.delete(room.roomId)
}

/** Announce + destroy. `reason` lets a client tell "host left" from "started". */
function closeRoom(io: Server, room: PrivateRoom, reason: string): void {
  io.to(channelOf(room)).emit('private:closed', { roomId: room.roomId, reason })
  // …and the people who were only ever INVITED, who are in no channel.
  notifyInvitesClosed(room, reason)
  destroyRoom(io, room)
}

/**
 * Remove one socket from whatever private room it is in.
 * - host leaves  → the room CLOSES for everyone (design contract)
 * - last player  → the room is dropped silently
 * - otherwise    → survivors get a fresh private:room, any countdown aborts
 */
function releaseSocket(io: Server, socket: Socket): void {
  const roomId = roomBySocket.get(socket.id)
  if (!roomId) return
  roomBySocket.delete(socket.id)

  const room = rooms.get(roomId)
  if (!room) return

  const leaver = room.players.find((member) => member.socketId === socket.id)
  if (!leaver) return

  room.players = room.players.filter((member) => member.socketId !== socket.id)

  if (leaver.wallet === room.hostWallet) {
    // THE LEAVER IS STILL IN THE CHANNEL HERE, deliberately. This runs for an
    // explicit `private:leave`, a disconnect, AND when a socket abandons one
    // room to create or join another — and in that last case a DIFFERENT
    // component may still be rendering the room being abandoned (a lobby's own
    // waiting room, say, while an invite is accepted from the nav bar). If we
    // left the channel first, that component would never hear `private:closed`
    // and would sit there rendering a room the server has already destroyed,
    // with a READY button the server silently ignores.
    closeRoom(io, room, 'host_left')
    socket.leave(channelOf(room))
    return
  }

  socket.leave(channelOf(room))
  if (room.players.length === 0) {
    destroyRoom(io, room)
    return
  }

  // A pending start can no longer be honoured with the old roster.
  if (room.status === 'starting') {
    clearCountdown(room)
    room.status = 'open'
  }
  broadcastRoom(io, room)
}

// ---------------------------------------------------------------------------
// Starting the real match
// ---------------------------------------------------------------------------

/**
 * Fire a game module's OWN matchmaking listener for this socket, exactly as
 * if the client had clicked "Wager Match". `socket.listeners(event)` returns
 * the handlers `registerChess` / `registerVolley` / … attached to THIS
 * connection, so the module builds its normal game state and emits its normal
 * start event — no game logic is duplicated here.
 *
 * Never awaited: every member must be handed to the queue inside ONE tick so
 * nothing can slip between them.
 */
function dispatchFind(socket: Socket, spec: GameModeSpec, mode: string): boolean {
  const listeners = socket.listeners(spec.findEvent)
  if (listeners.length === 0) {
    console.error(`[privateMatch] no listener for ${spec.findEvent}`)
    return false
  }
  const payload = spec.findPayload(mode)
  for (const listener of listeners) {
    try {
      const result = (listener as (arg: unknown) => unknown)(payload)
      // Async handlers (chess/volley) return a promise — swallow rejections
      // so one bad start can never take the process down.
      if (result instanceof Promise) {
        result.catch((err) =>
          console.error(`[privateMatch] ${spec.findEvent} failed:`, err)
        )
      }
    } catch (err) {
      console.error(`[privateMatch] ${spec.findEvent} threw:`, err)
      return false
    }
  }
  return true
}

/**
 * The countdown elapsed: hand every member to their game's normal
 * matchmaking, in the same tick, then retire the room.
 */
function startRoom(io: Server, room: PrivateRoom): void {
  room.countdownTimer = null
  if (room.status !== 'starting') return

  // Only members whose socket is still alive can be started.
  const sockets: Socket[] = []
  for (const member of room.players) {
    const socket = io.sockets.sockets.get(member.socketId)
    if (socket && !socket.disconnected) sockets.push(socket)
  }

  if (sockets.length < MIN_PLAYERS) {
    // Somebody vanished during the countdown — fall back to the waiting room
    // instead of starting a match nobody can play.
    room.status = 'open'
    for (const socket of sockets) {
      emitError(socket, 'start_failed', 'A player left before the match started')
    }
    broadcastRoom(io, room)
    return
  }

  // Tell the waiting room it is done BEFORE the game's start event lands, so
  // the client unmounts in a defined order. (private:closed is deliberately
  // NOT reused here — a client must not treat a start as an abort.)
  io.to(channelOf(room)).emit('private:started', {
    roomId: room.roomId,
    gameKey: room.gameKey,
    mode: room.mode,
  })
  // Anyone still holding an unaccepted invite to this room can stop offering
  // a JOIN — the match they were invited to is under way without them.
  notifyInvitesClosed(room, 'closed')

  const spec = room.spec
  const mode = room.mode
  const partyId = room.roomId
  destroyRoom(io, room)

  // PARTY STAMP: joinQueue (socket/queue.ts) reads this at enqueue time and
  // matches party members with each other and ONLY each other — no public
  // stranger can be swept into this match and no member can be poached by
  // the public pool while the finds below fan out. Stamped with a short TTL
  // instead of deleted afterwards because chess/volley's find handlers await
  // before they reach joinQueue; a stale stamp self-expires long before the
  // player could be back on a lobby clicking a public Find button.
  for (const socket of sockets) {
    socket.data.privateParty = { id: partyId, until: Date.now() + 5_000 }
  }

  // SAME TICK for every player: the queue pairs them with each other.
  for (const socket of sockets) {
    if (!dispatchFind(socket, spec, mode)) {
      emitError(socket, 'start_failed', 'Could not start the match — try again')
    }
  }
}

/** Everyone ready AND at least two players? Run the 3-2-1 and start. */
function maybeStart(io: Server, room: PrivateRoom): void {
  if (room.status !== 'open') return
  if (room.players.length < MIN_PLAYERS) return
  if (!room.players.every((member) => member.ready)) return

  room.status = 'starting'
  broadcastRoom(io, room) // status flips to 'starting' for the UI
  io.to(channelOf(room)).emit('private:countdown', { seconds: COUNTDOWN_SECONDS })
  room.countdownTimer = setTimeout(() => startRoom(io, room), COUNTDOWN_MS)
}

// ---------------------------------------------------------------------------
// Housekeeping — expired invites and abandoned rooms
// ---------------------------------------------------------------------------

/** The Server instance, captured on the first connection so the sweep below
 *  can announce a closure. Null until anybody connects (nothing to sweep). */
let serverRef: Server | null = null

setInterval(() => {
  const now = Date.now()
  for (const room of [...rooms.values()]) {
    // 5-MINUTE INVITE EXPIRY (contract). Join also re-checks, so this sweep is
    // only about not holding stale rows in memory.
    for (const [wallet, invite] of room.invites) {
      if (invite.expiresAt <= now) room.invites.delete(wallet)
    }
    // A room with nobody in it, or one that has sat open for an hour, is dead
    // weight. (Normal exits already destroy the room synchronously.)
    const stale = room.players.length === 0 || now - room.createdAt > ROOM_TTL_MS
    if (!stale) continue
    if (serverRef) {
      closeRoom(serverRef, room, 'expired') // survivors are told, then dropped
    } else {
      clearCountdown(room)
      rooms.delete(room.roomId)
    }
  }
  // NOTE: like socket/presence.ts this interval lives for the life of the
  // process on purpose — private rooms exist for as long as the server does.
}, SWEEP_INTERVAL_MS)

// ---------------------------------------------------------------------------
// registerPrivateMatch — wires this socket's private:* events + its OWN
// disconnect cleanup (design contract: no central disconnect loop).
// ---------------------------------------------------------------------------

export function registerPrivateMatch(io: Server, socket: Socket): void {
  serverRef = io // lets the housekeeping sweep announce a closure

  /** Identity from the handshake — never from a payload. */
  const wallet = socket.data.wallet as string | undefined

  // ------------------------------------------------- invite replay on connect
  /**
   * An invite is IN-MEMORY server state with a 5-minute life, but the only
   * time it was ever announced was the instant it was created. So a player who
   * reloaded the page — or whose socket dropped for a moment — silently lost a
   * perfectly live invitation: it was still joinable, and nothing on their
   * screen knew about it.
   *
   * Now every fresh connection is told about the invites addressed to it. The
   * client's notification store is keyed by roomId, so a replay to a tab that
   * already has the card is a harmless no-op rather than a duplicate.
   *
   * Emitted straight on THIS socket rather than through `pushToWallet`: the
   * social module registers presence at connection time too, and we must not
   * depend on which of the two ran first.
   */
  if (wallet) {
    const now = Date.now()
    for (const room of rooms.values()) {
      if (room.status !== 'open') continue
      const invite = room.invites.get(wallet)
      if (!invite || invite.expiresAt <= now) continue
      // Already seated (a rejoin) — the room state itself will tell them.
      if (memberOf(room, wallet)) continue
      // `invitedPayload` carries the ORIGINAL expiry, so a replay does not
      // hand the client a fresh five minutes it does not have.
      socket.emit('private:invited', invitedPayload(room, invite))
    }
  }

  /** Private rooms are an online feature: a registered account is required
   *  (same refusal every game's matchmaking uses). */
  const identify = (): { wallet: string; username: string } | null => {
    const username = socket.data.username as string | null | undefined
    if (!wallet || !username) {
      socket.emit('gameAuthError', {
        code: 'no_account',
        message: 'Finish account setup to play online',
      })
      emitError(socket, 'no_account', 'Finish account setup to play online')
      return null
    }
    return { wallet, username }
  }

  // ---------------------------------------------------------- private:create
  socket.on('private:create', (payload: unknown) => {
    const parsed = createSchema.safeParse(payload)
    if (!parsed.success) {
      emitError(socket, 'bad_payload', 'Invalid room request')
      return
    }
    const me = identify()
    if (!me) return
    if (createLimiter(me.wallet)) {
      emitError(socket, 'rate_limited', 'Slow down a moment')
      return
    }

    const spec = CATALOG[parsed.data.gameKey]?.[parsed.data.mode]
    if (!spec) {
      // Covers cells/asteroids free play too — excluded by contract.
      emitError(socket, 'bad_mode', 'That game mode has no private match')
      return
    }

    // One private room per socket: creating a new one abandons the old.
    releaseSocket(io, socket)

    const room: PrivateRoom = {
      roomId: randomUUID(),
      gameKey: parsed.data.gameKey,
      mode: parsed.data.mode,
      spec,
      hostWallet: me.wallet,
      hostUsername: me.username,
      players: [
        {
          socketId: socket.id,
          wallet: me.wallet,
          username: me.username,
          ready: false,
        },
      ],
      invites: new Map(),
      open: parsed.data.open === true,
      status: 'open',
      countdownTimer: null,
      createdAt: Date.now(),
    }
    rooms.set(room.roomId, room)
    roomBySocket.set(socket.id, room.roomId)
    socket.join(channelOf(room))
    broadcastRoom(io, room)
  })

  // ---------------------------------------------------------- private:invite
  socket.on('private:invite', (payload: unknown) => {
    const parsed = inviteSchema.safeParse(payload)
    if (!parsed.success) {
      emitError(socket, 'bad_payload', 'Invalid invite')
      return
    }
    const me = identify()
    if (!me) return
    if (inviteLimiter(me.wallet)) {
      emitError(socket, 'rate_limited', 'Too many invites — try again shortly')
      return
    }

    const room = rooms.get(parsed.data.roomId)
    if (!room || room.status !== 'open' || !memberOf(room, me.wallet)) {
      // Not a member (or no such room) — never confirm a room exists.
      emitError(socket, 'not_found', 'That room is not available')
      return
    }
    if (room.players.length >= room.spec.capacity) {
      emitError(socket, 'room_full', 'This room is full')
      return
    }

    // NO USER ENUMERATION: unknown username, self-invite, not-a-friend and a
    // blocked pair all fail with the SAME generic code.
    void (async () => {
      const generic = () =>
        emitError(socket, 'invite_failed', 'Could not invite that player')

      const target = await resolveUsernameToWallet(parsed.data.username)
      if (!target || target.wallet === me.wallet) return generic()
      if (!(await areFriends(me.wallet, target.wallet))) return generic()

      // The room may have filled/closed while we were in the database.
      const live = rooms.get(parsed.data.roomId)
      if (!live || live.status !== 'open' || !memberOf(live, me.wallet)) {
        return emitError(socket, 'not_found', 'That room is not available')
      }
      if (memberOf(live, target.wallet)) return // already in the room — no-op

      const invite: RoomInvite = {
        wallet: target.wallet,
        username: target.username,
        fromUsername: me.username,
        expiresAt: Date.now() + INVITE_TTL_MS,
      }
      live.invites.set(target.wallet, invite)

      // Usernames only — the invitee never learns a wallet, and the inviter
      // never learns anything about the invitee they didn't already know.
      // (`expiresAt` is a timestamp, not an identity: see invitedPayload.)
      const delivered = pushToWallet(
        target.wallet,
        'private:invited',
        invitedPayload(live, invite)
      )
      if (delivered === 0) {
        // The invite still stands for 5 minutes if they come online.
        emitError(socket, 'friend_offline', `${target.username} is offline`)
      }
    })().catch((err) => {
      console.error('[privateMatch] invite failed:', err)
      emitError(socket, 'invite_failed', 'Could not invite that player')
    })
  })

  // ------------------------------------------------------------ private:join
  socket.on('private:join', (payload: unknown) => {
    const parsed = roomIdSchema.safeParse(payload)
    if (!parsed.success) {
      emitError(socket, 'bad_payload', 'Invalid room')
      return
    }
    const me = identify()
    if (!me) return
    if (actionLimiter(me.wallet)) {
      emitError(socket, 'rate_limited', 'Slow down a moment')
      return
    }

    const room = rooms.get(parsed.data.roomId)
    if (!room || room.status === 'closed') {
      // roomId tagged: the app-level host and a lobby's own room can both be
      // listening on this one socket, and only the instance that asked for
      // THIS room should react (see FATAL_OPEN_CODES on the client).
      emitError(socket, 'not_found', 'That room is no longer available', parsed.data.roomId)
      return
    }

    const existing = memberOf(room, me.wallet)
    if (!existing) {
      if (room.status !== 'open') {
        emitError(socket, 'already_started', 'That match is already starting', parsed.data.roomId)
        return
      }
      // AUTHORIZATION: the host, a live invite addressed to this wallet, or
      // any seat of an OPEN room (a posted public challenge).
      const invite = room.invites.get(me.wallet)
      const invited = invite !== undefined && invite.expiresAt > Date.now()
      if (me.wallet !== room.hostWallet && !invited && !room.open) {
        if (invite) room.invites.delete(me.wallet) // expired — clean it up
        emitError(socket, 'not_invited', 'You have not been invited', parsed.data.roomId)
        return
      }
      if (room.players.length >= room.spec.capacity) {
        emitError(socket, 'room_full', 'This room is full', parsed.data.roomId)
        return
      }
    }

    // Leave any OTHER private room first (a player is only ever in one).
    const currentRoomId = roomBySocket.get(socket.id)
    if (currentRoomId && currentRoomId !== room.roomId) releaseSocket(io, socket)

    if (existing) {
      // Rejoin from a new tab: rebind the seat instead of adding a duplicate.
      if (existing.socketId !== socket.id) {
        roomBySocket.delete(existing.socketId)
        io.sockets.sockets.get(existing.socketId)?.leave(channelOf(room))
        existing.socketId = socket.id
      }
    } else {
      room.players.push({
        socketId: socket.id,
        wallet: me.wallet,
        username: me.username,
        ready: false,
      })
    }

    roomBySocket.set(socket.id, room.roomId)
    socket.join(channelOf(room))
    broadcastRoom(io, room)
  })

  // ----------------------------------------------------------- private:ready
  socket.on('private:ready', (payload: unknown) => {
    const parsed = readySchema.safeParse(payload)
    if (!parsed.success) {
      emitError(socket, 'bad_payload', 'Invalid ready state')
      return
    }
    const me = identify()
    if (!me) return
    if (actionLimiter(me.wallet)) return // silent: ready is spammable by design

    const room = rooms.get(parsed.data.roomId)
    if (!room || room.status !== 'open') return // no room, or already starting
    const member = memberOf(room, me.wallet)
    if (!member || member.socketId !== socket.id) {
      emitError(socket, 'not_member', 'You are not in that room')
      return
    }

    if (member.ready === parsed.data.ready) return // nothing changed
    member.ready = parsed.data.ready
    broadcastRoom(io, room)
    maybeStart(io, room)
  })

  // --------------------------------------------------------- private:decline
  /**
   * "Later" on an invite card. Before the connect-time replay existed, a
   * decline could be a purely client-side forget — the invite simply lapsed on
   * its own timer and nothing ever re-announced it. Now that a fresh socket is
   * told about every live invite, forgetting locally is not enough: the next
   * reconnect would hand the card straight back, and a player who dismissed an
   * invite would keep being asked for five minutes.
   *
   * Deleting the row also frees the seat for somebody else in a 1v1 room.
   * Deliberately silent: the inviter is not told, so this can never be used to
   * probe whether a wallet is online. Idempotent — declining something that is
   * not there is a no-op, so it cannot report whether a room exists either.
   */
  socket.on('private:decline', (payload: unknown) => {
    const parsed = roomIdSchema.safeParse(payload)
    if (!parsed.success) return
    if (!wallet) return
    if (actionLimiter(wallet)) return

    const room = rooms.get(parsed.data.roomId)
    if (!room?.invites.delete(wallet)) return

    // ONE WALLET, MANY TABS. `private:invited` was delivered to every socket
    // of this wallet, so declining in one tab has to retire the card in the
    // others — otherwise they keep a JOIN button whose only possible answer is
    // now `not_invited`, and (because the invite row is gone) nothing will
    // ever retire it when the room finally closes.
    //
    // Guarded on membership: if this wallet is somehow ALSO seated in the room
    // from another tab, `private:closed` would tell that tab its live room had
    // died. Declining an invite must never do that.
    if (!memberOf(room, wallet)) {
      pushToWallet(wallet, 'private:closed', {
        roomId: room.roomId,
        reason: 'declined',
      })
    }
  })

  // ----------------------------------------------------------- private:leave
  socket.on('private:leave', (payload: unknown) => {
    const parsed = roomIdSchema.safeParse(payload)
    if (!parsed.success) {
      emitError(socket, 'bad_payload', 'Invalid room')
      return
    }
    // The roomId is advisory — the server trusts its own socket→room index,
    // so a payload can never eject somebody else.
    const bound = roomBySocket.get(socket.id)
    if (!bound || bound !== parsed.data.roomId) return
    releaseSocket(io, socket)
  })

  // ------------------------------------------------------------- disconnect
  socket.on('disconnect', () => {
    releaseSocket(io, socket)
  })
}

// ---------------------------------------------------------------------------
// Read-only helper (ops / debugging) — wallet-free by construction
// ---------------------------------------------------------------------------

/**
 * Every game/mode a private room can host, with the seats it offers. Safe to
 * serve to a client (it is static configuration, not user data) — useful for
 * the lobby's "PRIVATE WAGER" picker so the UI can't offer an unsupported mode.
 */
export function privateWagerModes(): Array<{
  gameKey: string
  mode: string
  capacity: number
}> {
  const out: Array<{ gameKey: string; mode: string; capacity: number }> = []
  for (const [gameKey, modes] of Object.entries(CATALOG)) {
    for (const [mode, spec] of Object.entries(modes)) {
      out.push({ gameKey, mode, capacity: spec.capacity })
    }
  }
  return out
}

/** Snapshot of the live private rooms. Usernames only. */
export function privateRoomSnapshot(): Array<{
  roomId: string
  gameKey: string
  mode: string
  status: string
  players: string[]
}> {
  return [...rooms.values()].map((room) => ({
    roomId: room.roomId,
    gameKey: room.gameKey,
    mode: room.mode,
    status: room.status,
    players: room.players.map((member) => member.username),
  }))
}
