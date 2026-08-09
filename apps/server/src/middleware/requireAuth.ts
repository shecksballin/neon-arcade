/**
 * requireAuth MIDDLEWARE
 * ======================
 * Guards any route that needs a signed-in user. Checks the
 * `Authorization: Bearer <jwt>` header, verifies the token with our
 * JWT_SECRET, and attaches the wallet address to the request context.
 *
 * THE RULE (from the security protocol): the authenticated identity is
 * ALWAYS `c.get('wallet')` — set here from the verified JWT. Wallet
 * addresses arriving in bodies/params are never trusted for identity.
 *
 * Usage:
 *   const route = new Hono<{ Variables: AuthVariables }>()
 *   route.get('/me', requireAuth, (c) => { const wallet = c.get('wallet') ... })
 */

import { createMiddleware } from 'hono/factory'
import { verify } from 'hono/jwt'
import { config } from '../config/env'

// What requireAuth adds to the Hono context for downstream handlers
export type AuthVariables = {
  wallet: string
}

export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    // No secret configured → auth can't work at all. 503 (server-side
    // problem), not 401 (client-side problem).
    if (!config.JWT_SECRET) {
      return c.json({ error: 'Auth is not configured on this server' }, 503)
    }

    const header = c.req.header('Authorization')
    if (!header || !header.startsWith('Bearer ')) {
      return c.json({ error: 'Missing bearer token' }, 401)
    }

    const token = header.slice('Bearer '.length)

    try {
      // verify() throws on a bad signature OR an expired `exp` claim
      const payload = await verify(token, config.JWT_SECRET, 'HS256')
      const wallet = payload.wallet
      if (typeof wallet !== 'string' || wallet.length === 0) {
        throw new Error('token payload missing wallet')
      }
      c.set('wallet', wallet)
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    await next()
  }
)
