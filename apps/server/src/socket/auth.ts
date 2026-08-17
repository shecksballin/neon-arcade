/**
 * SOCKET HANDSHAKE AUTH (main "/" namespace)
 * ==========================================
 * The socket twin of middleware/requireAuth.ts: verifies the session JWT
 * the client sends in `socket.handshake.auth.token` and stamps the ONLY
 * trusted identity onto the connection:
 *
 *   socket.data.wallet   — from the verified JWT (NEVER from a payload)
 *   socket.data.username — looked up from the users table (null when the
 *                          wallet has no registered account, or no DB)
 *
 * Game handlers must require a registered username before matchmaking
 * (emit `gameAuthError { code: 'no_account' }` when it is null) — but that
 * check lives in each register* handler, not here, so the connection
 * itself stays usable for account-setup flows.
 *
 * Rejections (client sees them as `connect_error`):
 *   'auth_unavailable' — JWT_SECRET missing on the server (503-equivalent)
 *   'unauthorized'     — missing / invalid / expired token
 */

import type { ExtendedError, Socket } from 'socket.io'
import { verify } from 'hono/jwt'
import { eq } from 'drizzle-orm'
import { config } from '../config/env'
import { db } from '../db'
import { users } from '../db/schema'

export async function socketAuth(
  socket: Socket,
  next: (err?: ExtendedError) => void
) {
  // No secret configured → auth can't work at all. Reject every main-
  // namespace connection (the anonymous /presence namespace is unaffected).
  if (!config.JWT_SECRET) {
    return next(new Error('auth_unavailable'))
  }

  const token = socket.handshake.auth?.token
  if (typeof token !== 'string' || token.length === 0) {
    return next(new Error('unauthorized'))
  }

  let wallet: string
  let issuedAt: unknown
  try {
    // verify() throws on a bad signature OR an expired `exp` claim —
    // exactly the same call requireAuth.ts makes for HTTP routes.
    const payload = await verify(token, config.JWT_SECRET, 'HS256')
    const claim = payload.wallet
    if (typeof claim !== 'string' || claim.length === 0) {
      throw new Error('token payload missing wallet')
    }
    wallet = claim
    issuedAt = payload.iat
  } catch {
    return next(new Error('unauthorized'))
  }

  socket.data.wallet = wallet

  // Username lookup — best-effort. A DB hiccup must not reject an
  // otherwise-valid token; the player just looks unregistered until the
  // next reconnect (game handlers will refuse matchmaking with
  // 'no_account'). When db is null (no DATABASE_URL) the same applies.
  //
  // The revocation stamp rides along in the SAME query, so honouring
  // sign-out here costs nothing extra. A socket is a long-lived
  // credential — leaving one connected after the account signed out would
  // undo the whole point of revoking the token, since matchmaking, chat
  // and free-play all flow over it.
  socket.data.username = null
  let revokedAt: number | null = null
  if (db) {
    try {
      const [row] = await db
        .select({ username: users.username, validFrom: users.sessionsValidFrom })
        .from(users)
        .where(eq(users.wallet, wallet))
        .limit(1)
      socket.data.username = row?.username ?? null
      revokedAt = row?.validFrom ?? null
    } catch (err) {
      console.error('[socket] username lookup failed:', err)
    }
  }

  // Same comparison (and the same fail-open posture) as
  // lib/sessionRevocation.ts: a lookup that never ran leaves revokedAt
  // null and the connection proceeds.
  if (
    revokedAt !== null &&
    (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt) || issuedAt < revokedAt)
  ) {
    return next(new Error('unauthorized'))
  }

  next()
}
