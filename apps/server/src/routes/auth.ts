/**
 * AUTH ROUTES (Hono)
 * ===================
 * Wallet-signature sign-in. Privy owns the login UI and the wallets on
 * the frontend (embedded wallets + Phantom etc.) — this server never
 * talks to Privy. Instead the client PROVES it owns a wallet address by
 * signing a one-time nonce with that wallet, and we verify the ed25519
 * signature ourselves, then mint our own short-lived JWT. Every
 * protected route/socket trusts ONLY that JWT from then on.
 *
 * Flow (mirrors useBackendAuth on the frontend):
 *   1. GET  /api/auth/nonce?wallet=...           → { nonce }  (2-min expiry)
 *   2. client signs  "Sign in to Neon Arcade\nNonce: <nonce>"
 *   3. POST /api/auth/verify {wallet,signature,nonce} → { token }
 *   4. GET  /api/auth/me   (Authorization: Bearer)    → the authed user
 *
 * Why a nonce at all? Without one, a captured signature could be
 * replayed forever to mint fresh tokens. The nonce is single-use and
 * expires in 2 minutes, so a signature is only good for one sign-in.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { sign } from 'hono/jwt'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm'
import { buildSignInMessage } from '@neon/types'
import { config } from '../config/env'
import { requireDb } from '../db'
import { users, nonces } from '../db/schema'
import { requireAuth, type AuthVariables } from '../middleware/requireAuth'

const auth = new Hono<{ Variables: AuthVariables }>()

// How long a minted session token lives. "Short-lived" per the security
// protocol — 24h means at most one signature popup per day per device.
const TOKEN_TTL_SECONDS = 60 * 60 * 24

// Nonces expire fast: they only need to survive the round-trip to the
// wallet's signing UI.
const NONCE_TTL_MS = 2 * 60 * 1000

// Solana addresses are base58-encoded 32-byte ed25519 public keys,
// which encode to 32–44 characters.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/
const WalletSchema = z.string().min(32).max(44).regex(BASE58)

// ─────────────────────────────────────────────────
// NONCE STORE — Drizzle `nonces` table, Map fallback
// ─────────────────────────────────────────────────
// The real store is the `nonces` table (schema §8): rows survive
// restarts and work across multiple instances, and consumption is an
// ATOMIC single-statement update (set used_at WHERE unused + unexpired,
// RETURNING) so two concurrent /verify calls can never both spend the
// same nonce. When the server runs without DATABASE_URL (db === null)
// we keep the old in-memory Map so sign-in still works in dev.
interface NonceRecord {
  wallet: string
  expiresAt: number
}
const memoryNonces = new Map<string, NonceRecord>()

/** Drop expired Map entries so the fallback store can't grow forever. */
function sweepMemoryNonces() {
  const now = Date.now()
  for (const [nonce, record] of memoryNonces) {
    if (record.expiresAt <= now) memoryNonces.delete(nonce)
  }
}

// ─────────────────────────────────────────────────
// RATE LIMIT — in-memory sliding window
// ─────────────────────────────────────────────────
// Security protocol: auth endpoints get 10 requests / 15 min, keyed by
// wallet. Moves to Redis when we run more than one instance.
const RATE_WINDOW_MS = 15 * 60 * 1000
const RATE_MAX = 10
const hits = new Map<string, number[]>()

/** True if `key` has exceeded RATE_MAX requests in the window. */
function rateLimited(key: string): boolean {
  const now = Date.now()
  const windowStart = now - RATE_WINDOW_MS
  const recent = (hits.get(key) ?? []).filter((t) => t > windowStart)
  if (recent.length >= RATE_MAX) {
    hits.set(key, recent)
    return true
  }
  recent.push(now)
  hits.set(key, recent)
  return false
}

// ─────────────────────────────────────────────────
// GET /api/auth/nonce?wallet=<address>
// ─────────────────────────────────────────────────
auth.get('/nonce', async (c) => {
  const parsed = WalletSchema.safeParse(c.req.query('wallet'))
  if (!parsed.success) {
    return c.json({ error: 'Invalid wallet address' }, 400)
  }
  const wallet = parsed.data

  if (rateLimited(`nonce:${wallet}`)) {
    return c.json({ error: 'Too many requests — try again later' }, 429)
  }

  const nonce = crypto.randomUUID()
  const db = requireDb()

  if (db) {
    // Opportunistic sweep: expired rows are dead weight (a consume can
    // never match them), so clear them out on the issue path.
    await db.delete(nonces).where(lte(nonces.expiresAt, sql`now()`))

    await db.insert(nonces).values({
      nonce,
      wallet,
      expiresAt: new Date(Date.now() + NONCE_TTL_MS),
    })
  } else {
    // No database — fall back to the in-memory store (dev only).
    sweepMemoryNonces()
    memoryNonces.set(nonce, { wallet, expiresAt: Date.now() + NONCE_TTL_MS })
  }

  return c.json({ nonce })
})

// ─────────────────────────────────────────────────
// POST /api/auth/verify  { wallet, signature, nonce }
// ─────────────────────────────────────────────────
const VerifySchema = z.object({
  wallet: WalletSchema,
  // base58 of a 64-byte ed25519 signature (~86–88 chars)
  signature: z.string().min(64).max(120).regex(BASE58),
  nonce: z.string().uuid(),
})

auth.post('/verify', async (c) => {
  // Auth needs a signing secret. Fail loudly (and honestly) if the
  // server was booted without one.
  if (!config.JWT_SECRET) {
    console.error('JWT_SECRET is missing — add it to Doppler (≥32 chars)')
    return c.json({ error: 'Auth is not configured on this server' }, 503)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = VerifySchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400)
  }
  const { wallet, signature, nonce } = parsed.data

  if (rateLimited(`verify:${wallet}`)) {
    return c.json({ error: 'Too many requests — try again later' }, 429)
  }

  // Consume the nonce FIRST (single-use, whatever happens next). A
  // failed signature check must still burn it, or it could be
  // brute-forced with repeated attempts.
  const db = requireDb()
  let issuedToWallet: string | null = null

  if (db) {
    // Atomic consume: exactly one statement claims the nonce by setting
    // used_at, guarded on "not yet used" and "not yet expired". If two
    // requests race, only one gets a row back — the other sees an empty
    // RETURNING and is rejected below. This is why consumed rows are
    // marked rather than deleted.
    const [claimed] = await db
      .update(nonces)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(nonces.nonce, nonce),
          isNull(nonces.usedAt),
          gt(nonces.expiresAt, sql`now()`)
        )
      )
      .returning()

    issuedToWallet = claimed?.wallet ?? null
  } else {
    // In-memory fallback (no DATABASE_URL): delete = consume.
    const record = memoryNonces.get(nonce)
    memoryNonces.delete(nonce)
    issuedToWallet =
      record && record.expiresAt > Date.now() ? record.wallet : null
  }

  if (!issuedToWallet) {
    return c.json({ error: 'Nonce expired or unknown — request a new one' }, 401)
  }
  if (issuedToWallet !== wallet) {
    return c.json({ error: 'Nonce was issued to a different wallet' }, 401)
  }

  // Verify the ed25519 signature: the wallet address IS the public key.
  let signatureOk = false
  try {
    const publicKey = bs58.decode(wallet) // 32 bytes
    const sigBytes = bs58.decode(signature) // 64 bytes
    const message = new TextEncoder().encode(buildSignInMessage(nonce))
    signatureOk =
      publicKey.length === 32 &&
      sigBytes.length === 64 &&
      nacl.sign.detached.verify(message, sigBytes, publicKey)
  } catch {
    signatureOk = false
  }

  if (!signatureOk) {
    return c.json({ error: 'Signature verification failed' }, 401)
  }

  // Ownership proven — mint our session token. `wallet` inside the JWT
  // is what requireAuth exposes as the ONLY trusted identity.
  const now = Math.floor(Date.now() / 1000)
  const token = await sign(
    { wallet, iat: now, exp: now + TOKEN_TTL_SECONDS },
    config.JWT_SECRET
  )

  return c.json({ token })
})

// ─────────────────────────────────────────────────
// GET /api/auth/me — who does this token belong to?
// ─────────────────────────────────────────────────
// Backed by the Drizzle `users` table now. A wallet that signed in but
// never registered gets the fresh-account shape (null username, 0 ELO)
// — same when the server runs without a database.
auth.get('/me', requireAuth, async (c) => {
  const wallet = c.get('wallet')

  const db = requireDb()
  const [row] = db
    ? await db.select().from(users).where(eq(users.wallet, wallet)).limit(1)
    : [undefined]

  return c.json({
    wallet,
    username: row?.username ?? null,
    elo: row?.elo ?? 0,
    eloFfa: row?.eloFfa ?? 0,
  })
})

export default auth
