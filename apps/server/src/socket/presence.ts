/**
 * "/presence" NAMESPACE — anonymous active-user counter
 * =====================================================
 * Ported from _server_ref/server.ts (the presence block), moved onto its
 * own socket.io namespace so it needs NO auth token — the landing page
 * shows "N pilots online" before anyone signs in.
 *
 * How it works:
 * - Each connection gets a random sessionId (server-side only) that is
 *   marked active on connect and on every accepted heartbeat.
 * - Clients emit 'heartbeat' every ~20s; the server THROTTLES accepts to
 *   one per 10s per session so a hostile client can't spam timestamps.
 * - Sessions idle for 30s (TTL) are pruned during the count sweep, so a
 *   dead tab stops counting even if 'disconnect' never fired.
 * - Every 5s the namespace broadcasts 'presence:update { activeUsers }'.
 * - Per-IP connection cap of 10 (x-forwarded-for aware, since Railway/
 *   proxies terminate TLS in front of us) keeps one laptop from faking a
 *   crowd or exhausting sockets.
 */

import { randomUUID } from 'node:crypto'
import type { Server, Socket } from 'socket.io'

const PRESENCE_TTL_SECONDS = 30 // idle sessions vanish after this
const HEARTBEAT_MIN_MS = 10_000 // accept at most one heartbeat per 10s
const MAX_CONNECTIONS_PER_IP = 10 // anti-abuse cap
const BROADCAST_INTERVAL_MS = 5_000 // aggregate count cadence

export function createPresenceNamespace(io: Server) {
  const nsp = io.of('/presence')

  // All state is in-memory and namespace-local — presence is best-effort
  // by design (a restart just resets the count to whoever reconnects).
  const ipConnectionCount = new Map<string, number>()
  const heartbeatTimestamps = new Map<string, number>()
  const activeSessions = new Map<string, number>() // sessionId → lastSeen

  // First hop of x-forwarded-for is the real client when a proxy fronts
  // us; fall back to the direct remote address for bare local dev.
  function getClientIp(socket: Socket): string {
    const forwarded = socket.handshake.headers['x-forwarded-for']
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
    return first?.split(',')[0]?.trim() || socket.handshake.address || 'unknown'
  }

  // Count live sessions, pruning anything past the TTL as we go.
  function getActiveCount(): number {
    const now = Date.now()
    let count = 0
    for (const [sessionId, lastSeen] of activeSessions) {
      if (now - lastSeen > PRESENCE_TTL_SECONDS * 1000) {
        activeSessions.delete(sessionId)
      } else {
        count++
      }
    }
    return count
  }

  // Connection gate: enforce the per-IP cap BEFORE the socket is accepted.
  nsp.use((socket, next) => {
    const ip = getClientIp(socket)
    if ((ipConnectionCount.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
      return next(new Error('Too many connections'))
    }
    socket.data.sessionId = randomUUID()
    socket.data.ip = ip
    next()
  })

  nsp.on('connection', (socket) => {
    const { sessionId, ip } = socket.data as { sessionId: string; ip: string }

    ipConnectionCount.set(ip, (ipConnectionCount.get(ip) ?? 0) + 1)
    activeSessions.set(sessionId, Date.now())

    socket.on('heartbeat', () => {
      const now = Date.now()
      const last = heartbeatTimestamps.get(sessionId) ?? 0
      if (now - last < HEARTBEAT_MIN_MS) return // throttled — ignore
      heartbeatTimestamps.set(sessionId, now)
      activeSessions.set(sessionId, now)
    })

    socket.on('disconnect', () => {
      activeSessions.delete(sessionId)
      heartbeatTimestamps.delete(sessionId)
      const count = (ipConnectionCount.get(ip) ?? 1) - 1
      if (count <= 0) ipConnectionCount.delete(ip)
      else ipConnectionCount.set(ip, count)
    })
  })

  // Aggregate broadcast — anonymous count only, never identities. The
  // interval intentionally lives forever (presence runs for the life of
  // the process); the guard mirrors the ref so a weird count can never
  // reach clients and a thrown emit can never kill the process.
  setInterval(() => {
    try {
      const count = getActiveCount()
      if (!Number.isInteger(count) || count < 0) return
      nsp.emit('presence:update', { activeUsers: count })
    } catch {
      // best-effort — skip this tick
    }
  }, BROADCAST_INTERVAL_MS)
}
