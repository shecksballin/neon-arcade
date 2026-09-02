/**
 * GIFT SERVICE (WAGERING_IMPLEMENTATION.md §8)
 * ============================================
 * Direct SOL between players, routed through the house wallet so BOTH legs
 * are verified and logged: sender → house (verifyDeposit) then house →
 * recipient (sendPayout), minus the house fee.
 *
 * The §8 edge rules live here:
 *   - recipient needs no account (users upserted on the fly),
 *   - GIFT_DAILY_CAP_SOL is the money-laundering brake — reject over cap,
 *   - a failed outbound leg records status='failed_payout' and alerts:
 *     the SOL is in the house wallet and a HUMAN resolves it (§7.6).
 */

import { and, eq, gte, sql } from 'drizzle-orm'
import { config } from '../config/env'
import { db } from '../db'
import { deposits, gifts, notifications, payouts, users } from '../db/schema'
import { consumeNonce } from './nonceService'
import { sendPayout, verifyDeposit } from '../solana/payoutService'
import { alert } from './alertService'

function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9
}

export type SendGiftResult =
  | { ok: true; payoutSol: number }
  | { ok: false; status: 400 | 409 | 503; error: string }

export async function sendGift(opts: {
  /** JWT identity — the route passes c.get('wallet'). */
  fromWallet: string
  toWallet: string
  amountSol: number
  txSig: string
  nonce: string
}): Promise<SendGiftResult> {
  if (!db) return { ok: false, status: 503, error: 'no database' }

  // Route Zod already refuses self-gifts (§8 step 1); repeated here so no
  // future caller can route fee-laundering through the service directly.
  if (opts.toWallet === opts.fromWallet) {
    return { ok: false, status: 400, error: 'cannot gift yourself' }
  }

  // 2. One-time nonce.
  if (!(await consumeNonce(opts.nonce, opts.fromWallet))) {
    return { ok: false, status: 400, error: 'invalid or expired nonce' }
  }

  // DAILY CAP (§8): Σ of the sender's gifts today, cap enforced BEFORE the
  // chain is consulted. UTC midnight window — deterministic across regions.
  const midnight = new Date()
  midnight.setUTCHours(0, 0, 0, 0)
  const [{ total }] = await db
    .select({
      total: sql<string>`coalesce(sum(${gifts.amountSol}), 0)`,
    })
    .from(gifts)
    .where(
      and(eq(gifts.fromWallet, opts.fromWallet), gte(gifts.createdAt, midnight))
    )
  if (Number(total) + opts.amountSol > config.GIFT_DAILY_CAP_SOL) {
    return { ok: false, status: 400, error: 'daily gift cap reached' }
  }

  // 3. Inbound leg proof.
  try {
    await verifyDeposit({
      txSignature: opts.txSig,
      expectedSender: opts.fromWallet,
      expectedAmountSOL: opts.amountSol,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'verification failed'
    return { ok: false, status: 400, error: msg }
  }

  // 4. Replay backstop — same deposits table, matchId null (§8 step 4).
  try {
    await db.insert(deposits).values({
      matchId: null,
      wallet: opts.fromWallet,
      amountSol: opts.amountSol.toFixed(9),
      txSig: opts.txSig,
    })
  } catch (err) {
    const e = err as { code?: string; message?: string }
    if (e?.code === '23505' || /duplicate key/i.test(String(e?.message))) {
      return { ok: false, status: 409, error: 'gift already processed' }
    }
    throw err
  }

  // Recipient may be brand new (§8): upsert so notifications/history have
  // a row to hang off. ON CONFLICT DO NOTHING — racing a real sign-in is a
  // no-op, and the sign-in path owns filling the profile in.
  await db.insert(users).values({ wallet: opts.toWallet }).onConflictDoNothing()

  // 5. Outbound leg.
  const feeSol = round9(opts.amountSol * (config.HOUSE_FEE_PERCENT / 100))
  const payoutSol = round9(opts.amountSol - feeSol)
  let payoutTxSig: string
  try {
    payoutTxSig = await sendPayout(opts.toWallet, payoutSol)
  } catch (err) {
    // The sender's SOL is verified-in but the outbound leg failed: record
    // failed_payout for the orphaned queue and alert. Human resolves —
    // never auto-retry (§8).
    await db.insert(gifts).values({
      fromWallet: opts.fromWallet,
      toWallet: opts.toWallet,
      amountSol: opts.amountSol.toFixed(9),
      feeSol: feeSol.toFixed(9),
      depositTxSig: opts.txSig,
      payoutTxSig: null,
      status: 'failed_payout',
    })
    alert('critical', 'gift payout failed — SOL held in house wallet', {
      amount: opts.amountSol,
      message: err instanceof Error ? err.message : 'unknown',
    })
    return { ok: false, status: 503, error: 'gift payout failed — support has been alerted' }
  }

  // 6. Books, one transaction: the gift row + the payouts row.
  await db.transaction(async (tx) => {
    await tx.insert(gifts).values({
      fromWallet: opts.fromWallet,
      toWallet: opts.toWallet,
      amountSol: opts.amountSol.toFixed(9),
      feeSol: feeSol.toFixed(9),
      depositTxSig: opts.txSig,
      payoutTxSig,
      status: 'completed',
    })
    await tx.insert(payouts).values({
      matchId: null,
      wallet: opts.toWallet,
      amountSol: payoutSol.toFixed(9),
      type: 'gift',
      txSig: payoutTxSig,
    })
  })

  // 7. Notification. USERNAMES ONLY in the data blob — the sender's wallet
  // must never reach the recipient (schema security note).
  const [sender] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.wallet, opts.fromWallet))
    .limit(1)
  await db.insert(notifications).values({
    wallet: opts.toWallet,
    type: 'gift',
    title: 'You received a gift!',
    body: `${sender?.username ?? 'A player'} sent you ${payoutSol} SOL`,
    data: JSON.stringify({
      fromUsername: sender?.username ?? null,
      amountSol: payoutSol,
    }),
  })

  return { ok: true, payoutSol }
}
