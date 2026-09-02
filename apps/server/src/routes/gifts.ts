/**
 * GIFT ROUTES (WAGERING_IMPLEMENTATION.md §8)
 * ===========================================
 *   POST /api/gifts/nonce  → { nonce, depositAddress }
 *   POST /api/gifts/send   ← { toWallet, amountSol, txSig, nonce }
 *
 * Rate limit: 5 gifts/min per wallet (§8). Identity is c.get('wallet').
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { config, wageringEnabled } from '../config/env'
import { requireAuth, type AuthVariables } from '../middleware/requireAuth'
import { createRateLimiter } from '../lib/rateLimit'
import { issueNonce } from '../services/nonceService'
import { sendGift } from '../services/giftService'

const gifts = new Hono<{ Variables: AuthVariables }>()

const nonceLimiter = createRateLimiter(60_000, 10)
const sendLimiter = createRateLimiter(60_000, 5)

gifts.use('*', async (c, next) => {
  if (!wageringEnabled) {
    return c.json({ error: 'Wagering is not configured on this server' }, 503)
  }
  await next()
})

gifts.post('/nonce', requireAuth, async (c) => {
  const wallet = c.get('wallet')
  if (nonceLimiter(wallet)) return c.json({ error: 'Too many requests' }, 429)
  const nonce = await issueNonce(wallet)
  return c.json({ nonce, depositAddress: config.HOUSE_WALLET_ADDRESS })
})

const sendSchema = z.object({
  toWallet: z.string().min(32).max(44),
  amountSol: z
    .number()
    .finite()
    .min(config.MIN_GIFT_SOL)
    .max(config.MAX_GIFT_SOL),
  txSig: z.string().min(80).max(200),
  nonce: z.string().uuid(),
})

gifts.post('/send', requireAuth, async (c) => {
  const fromWallet = c.get('wallet')
  if (sendLimiter(fromWallet)) return c.json({ error: 'Too many requests' }, 429)

  const parsed = sendSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid gift payload' }, 400)
  // Self-gift is a fee-laundering no-op — §8 step 1 rejects it by shape.
  if (parsed.data.toWallet === fromWallet) {
    return c.json({ error: 'Cannot gift yourself' }, 400)
  }

  const result = await sendGift({ fromWallet, ...parsed.data })
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json({ ok: true, payoutSol: result.payoutSol })
})

export default gifts
