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
  try {
    // verify() throws on a bad signature OR an expired `exp` claim —
    // exactly the same call requireAuth.ts makes for HTTP routes.
    const payload = await verify(token, config.JWT_SECRET, 'HS256')
    const claim = payload.wallet
    if (typeof claim !== 'string' || claim.length === 0) {
      throw new Error('token payload missing wallet')
    }
    wallet = claim
  } catch {
    return next(new Error('unauthorized'))
  }

  socket.data.wallet = wallet

  // Username lookup — best-effort. A DB hiccup must not reject an
  // otherwise-valid token; the player just looks unregistered until the
  // next reconnect (game handlers will refuse matchmaking with
  // 'no_account'). When db is null (no DATABASE_URL) the same applies.
  socket.data.username = null
  if (db) {
    try {
      const [row] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.wallet, wallet))
        .limit(1)
      socket.data.username = row?.username ?? null
    } catch (err) {
      console.error('[socket] username lookup failed:', err)
    }
  }

  next()
}
