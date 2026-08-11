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

// ---------------------------------------------------------------------------
// Game handler modules
// ---------------------------------------------------------------------------
import { registerChess } from './games/chess'
import { registerConnect } from './games/connect'
import { registerVolley } from './games/volley'
import { registerTrivia } from './games/trivia'
import { registerFreeplay, shutdownFreeplay } from './freeplay'

// ---------------------------------------------------------------------------
// attachSocketHandlers
// ---------------------------------------------------------------------------
export function attachSocketHandlers(io: Server) {
  // Handshake JWT auth — every "/" connection carries a verified
  // socket.data.wallet (+ socket.data.username) or is rejected.
  io.use(socketAuth)

  io.on('connection', (socket) => {
    // Each register* wires its own events AND its own disconnect cleanup
    // (see the note in the header — no central disconnect loop).
    registerChess(io, socket)
    registerConnect(io, socket)
    registerVolley(io, socket)
    registerTrivia(io, socket)
    registerFreeplay(io, socket)
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
