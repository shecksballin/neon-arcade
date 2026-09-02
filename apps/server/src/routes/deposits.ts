/**
 * DEPOSIT ROUTES (WAGERING_IMPLEMENTATION.md §4.2)
 * ================================================
 *   POST /api/deposits/nonce     → { nonce, depositAddress }
 *   POST /api/deposits/confirm   ← { matchId, txSig, nonce, amountSol }
 *
 * Both authed, both rate-limited 10/min per wallet. Identity is ALWAYS
 * `c.get('wallet')` from the verified JWT (absolute rule §0.2) — the body
 * never names the depositor.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { config, wageringEnabled } from '../config/env'
import { requireAuth, type AuthVariables } from '../middleware/requireAuth'
import { createRateLimiter } from '../lib/rateLimit'
import { issueNonce } from '../services/nonceService'
import { confirmDeposit } from '../services/depositService'

const deposits = new Hono<{ Variables: AuthVariables }>()

// 10/min per wallet on BOTH routes (§4.2). Separate windows so hammering
// one route can't starve the other.
const nonceLimiter = createRateLimiter(60_000, 10)
const confirmLimiter = createRateLimiter(60_000, 10)

/** Wagering not configured → the whole feature answers 503, like every
 *  other secret-gated route group in this server. */
deposits.use('*', async (c, next) => {
  if (!wageringEnabled) {
    return c.json({ error: 'Wagering is not configured on this server' }, 503)
  }
  await next()
})

deposits.post('/nonce', requireAuth, async (c) => {
  const wallet = c.get('wallet')
  if (nonceLimiter(wallet)) {
    return c.json({ error: 'Too many requests' }, 429)
  }
  const nonce = await issueNonce(wallet)
  return c.json({ nonce, depositAddress: config.HOUSE_WALLET_ADDRESS })
})

// §4.2 step 1 — shape. Amount bounds come from config, so the schema is
// built where config is in scope.
const confirmSchema = z.object({
  matchId: z.string().uuid(),
  txSig: z.string().min(80).max(200),
  nonce: z.string().uuid(),
  amountSol: z
    .number()
    .finite()
    .min(config.MIN_BET_SOL)
    .max(config.MAX_BET_SOL),
})

deposits.post('/confirm', requireAuth, async (c) => {
  const wallet = c.get('wallet')
  if (confirmLimiter(wallet)) {
    return c.json({ error: 'Too many requests' }, 429)
  }

  const parsed = confirmSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Invalid deposit payload' }, 400)
  }

  const result = await confirmDeposit({ wallet, ...parsed.data })
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json({ ok: true })
})

export default deposits
