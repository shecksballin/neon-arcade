/**
 * SOCKET WIRING — attachSocketHandlers(io)
 * ========================================
 * One place that assembles the realtime side of the server:
 *
 * - JWT handshake auth on the MAIN "/" namespace (socket/auth.ts)
 * - per-connection registration of every game handler module
 * - the anonymous "/presence" namespace (socket/presence.ts — NO auth)
 * - graceful shutdown: SIGINT/SIGTERM auto-cash-out of free-play sessions
 *
 * DISCONNECT STRATEGY (deliberate): each register* module attaches its OWN
 * `socket.on('disconnect')` cleanup for its own games/queues. There is no
 * central disconnect loop here — the reference server's central loop
 * double-applied ELO and starved per-game handlers, so we don't repeat it.
 */

import type { Server } from 'socket.io'
import { socketAuth } from './auth'
import { createPresenceNamespace } from './presence'
// Friend presence + live message/friend-request delivery (socket/social.ts).
import {
  registerSocial,
  isWalletOnline,
  pushToWallet,
  pushFriendsOnlineTo,
} from './social'
// The HTTP social routes never import the socket layer (that cycle is how
// routes end up owning game state) — they take these three functions through
// a one-way bridge instead. See routes/social.ts `SocialRealtime`.
import { setSocialRealtime } from '../routes/social'

// ---------------------------------------------------------------------------
// Game handler modules
// ---------------------------------------------------------------------------
import { registerChess } from './games/chess'
import { registerConnect } from './games/connect'
import { registerVolley } from './games/volley'
import { registerTrivia } from './games/trivia'
import { registerLobbyGames } from './games/lobbyGames'
import { registerPrivateMatch } from './games/privateMatch'
import { registerFreeplay, shutdownFreeplay } from './freeplay'

// ---------------------------------------------------------------------------
// attachSocketHandlers
// ---------------------------------------------------------------------------
export function attachSocketHandlers(io: Server) {
  // Handshake JWT auth — every "/" connection carries a verified
  // socket.data.wallet (+ socket.data.username) or is rejected.
  io.use(socketAuth)

  // ---------------------------------------------------------------------
  // HTTP ↔ socket bridge (registered ONCE, at boot)
  // ---------------------------------------------------------------------
  // Without this, routes/social.ts degrades safely but silently: `online`
  // reads false for everyone and `social:message` / `social:friendRequest`
  // are never delivered live (the rows are still persisted, so nothing is
  // lost — it just looks like presence is broken).
  //
  // Only these three capabilities cross the boundary, and the wallet is
  // always the ADDRESS, never part of a payload.
  setSocialRealtime({
    isOnline: isWalletOnline,
    emitToWallet: (wallet, event, payload) => {
      pushToWallet(wallet, event, payload)
    },
    refreshFriendsOnline: (wallet) => {
      void pushFriendsOnlineTo(wallet).catch((err) =>
        console.error('[socket] friends-online refresh failed:', err)
      )
    },
  })

  io.on('connection', (socket) => {
    // Each register* wires its own events AND its own disconnect cleanup
    // (see the note in the header — no central disconnect loop).

    // FIRST: friend presence, so the wallet counts as online before anything
    // else can push to it (and so its friends' lists refresh immediately).
    registerSocial(io, socket)

    registerChess(io, socket)
    registerConnect(io, socket)
    registerVolley(io, socket)
    registerTrivia(io, socket)
    // Golf / Clumsy / Pug Shooter — queue + roster handoff for the iframe games
    registerLobbyGames(io, socket)
    registerFreeplay(io, socket)

    // LAST: private wager rooms. Registered after every game module because a
    // private start drives those modules' OWN matchmaking listeners, which
    // must already be attached to this socket by then.
    registerPrivateMatch(io, socket)
  })

  // Anonymous active-user counter on its own namespace — no token needed.
  createPresenceNamespace(io)

  // Graceful shutdown (permanent-server doc §7): before the process dies,
  // auto-cash-out every active free-play session so no pot is stranded in
  // the DB, then exit cleanly. Guarded so a double signal can't run the
  // cash-out twice.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[socket] ${signal} received — cashing out free-play sessions`)
    try {
      await shutdownFreeplay()
    } catch (err) {
      console.error('[socket] shutdownFreeplay failed:', err)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}
