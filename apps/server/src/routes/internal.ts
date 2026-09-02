/**
 * INTERNAL ROUTES (WAGERING_IMPLEMENTATION.md §1)
 * ===============================================
 *   GET /api/internal/health    — wagering health (config + house balance)
 *   GET /api/internal/balance   — house wallet balance
 *   GET /api/internal/orphaned  — the manual-review queue (§6.2/§8):
 *                                 matches stuck 'settling', gifts stuck
 *                                 'failed_payout', players stranded in
 *                                 'cashing_out'.
 *
 * AUTH-GATED: requireAuth at minimum. There is no admin-role system yet,
 * so these expose NO private data beyond aggregate money state — no keys,
 * no per-user balances, wallets only in the orphaned rows (which an
 * operator needs to resolve them). Lock down further when roles exist.
 */

import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { wageringEnabled } from '../config/env'
import { db } from '../db'
import { gifts, matches, matchPlayers } from '../db/schema'
import { requireAuth, type AuthVariables } from '../middleware/requireAuth'
import { getHouseBalance } from '../solana/payoutService'

const internal = new Hono<{ Variables: AuthVariables }>()

internal.use('*', async (c, next) => {
  if (!wageringEnabled) {
    return c.json({ error: 'Wagering is not configured on this server' }, 503)
  }
  await next()
})

internal.get('/health', requireAuth, async (c) => {
  try {
    const balance = await getHouseBalance()
    return c.json({ ok: true, houseBalanceSol: balance })
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown' },
      503
    )
  }
})

internal.get('/balance', requireAuth, async (c) => {
  const balance = await getHouseBalance()
  return c.json({ houseBalanceSol: balance })
})

internal.get('/orphaned', requireAuth, async (c) => {
  if (!db) return c.json({ error: 'no database' }, 503)

  const [settling, failedGifts, strandedCashouts] = await Promise.all([
    db.select().from(matches).where(eq(matches.status, 'settling')),
    db.select().from(gifts).where(eq(gifts.status, 'failed_payout')),
    // Stranded > 5 minutes — a LIVE cash-out passes through 'cashing_out'
    // for milliseconds; older rows mean a crash between claim and finalise.
    db
      .select()
      .from(matchPlayers)
      .where(
        sql`${matchPlayers.status} = 'cashing_out'
            AND ${matchPlayers.updatedAt} < now() - interval '5 minutes'`
      ),
  ])

  return c.json({ settling, failedGifts, strandedCashouts })
})

export default internal
