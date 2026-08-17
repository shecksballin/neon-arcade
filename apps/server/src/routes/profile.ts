/**
 * PROFILE ROUTES (Hono) — account registration + TOTP enrollment
 * ==============================================================
 * Runs AFTER wallet sign-in: every route here sits behind requireAuth,
 * so the only identity ever used is the verified `c.get('wallet')`.
 *
 * Flow (mirrors AccountSetup.tsx on the frontend):
 *   1. POST /api/profile/register  { username, pin }
 *        → unique username claimed, PIN hashed (argon2id via
 *          Bun.password), fresh TOTP secret minted (otpauth) and sealed
 *          (AES-256-GCM) into Neon via Drizzle. Responds with the
 *          otpauth:// URI, its QR code (server-rendered data URL — the
 *          browser just draws an <img>), and the base32 secret for
 *          manual entry.
 *   2. User scans the QR with an authenticator app.
 *   3. POST /api/profile/totp/verify { code }
 *        → code checked against the sealed secret; success flips
 *          totp_enabled and the account is live.
 *
 * Security notes:
 * - The PIN is 4 digits (10k combinations) — argon2id makes offline
 *   cracking of a leaked hash slow, and the per-wallet rate limit is
 *   what blunts online guessing. It is an account convenience factor;
 *   TOTP is the strong one.
 * - The TOTP secret leaves the server exactly once, in the register
 *   response over the authenticated channel. At rest it is AES-256-GCM
 *   sealed (lib/totpCrypto.ts) under Doppler's TOTP_ENC_KEY.
 * - Re-registering is allowed only while enrollment is unfinished
 *   (totp_enabled = false). Once TOTP is live, changing username/PIN/
 *   secret is an account-recovery problem, not a register call.
 * - Usernames are unique case-insensitively (DB functional index) —
 *   the registry started from zero when this shipped; no legacy name
 *   is reserved.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import QRCode from 'qrcode'
import {
  SEASON_START_RP,
  USERNAME_REGEX,
  PIN_REGEX,
  TOTP_CODE_REGEX,
  TOTP_ISSUER,
  getLevelInfo,
} from '@neon/types'
import { config } from '../config/env'
import { requireDb } from '../db'
import { users } from '../db/schema'
import { requireAuth, type AuthVariables } from '../middleware/requireAuth'
import { encryptTotpSecret, decryptTotpSecret } from '../lib/totpCrypto'
import { createRateLimiter } from '../lib/rateLimit'
import { linkIdentities } from '../services/accountService'

const profile = new Hono<{ Variables: AuthVariables }>()

// Everything here is about the signed-in account.
profile.use('*', requireAuth)

// Security protocol budgets, keyed by wallet: registration is rare, and
// TOTP codes must not be online-brute-forceable (10 guesses per 15 min
// against a 6-digit space is statistically hopeless).
const registerLimited = createRateLimiter(15 * 60 * 1000, 10)
const totpLimited = createRateLimiter(15 * 60 * 1000, 10)

// ─────────────────────────────────────────────────
// Config gates — 503 (server problem), never 401
// ─────────────────────────────────────────────────
function missingConfig() {
  if (!requireDb()) return 'Database is not configured on this server'
  if (!config.TOTP_ENC_KEY) return 'TOTP encryption is not configured on this server'
  return null
}

// ─────────────────────────────────────────────────
// GET /api/profile/me — account status for the gate
// ─────────────────────────────────────────────────
// The frontend calls this right after sign-in to decide whether to show
// AccountSetup (no username / unfinished TOTP) or let the user through.
profile.get('/me', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)

  const wallet = c.get('wallet')
  const [row] = await db.select().from(users).where(eq(users.wallet, wallet)).limit(1)

  // RANKED 2.0: `rp1v1` / `rpFfa` are the source of truth for the badge
  // (the client derives tier AND division from RP via getRankInfo). `elo` /
  // `eloFfa` are kept only as the legacy mirror rankService writes alongside
  // RP — the client's `rankRpOf` prefers `rp` and falls back to `elo`, so
  // sending both is a no-flag-day migration. The hidden TrueSkill layer
  // (mu/sigma) is deliberately NOT here: it would expose matchmaking.
  return c.json({
    wallet,
    username: row?.username ?? null,
    hasPin: !!row?.pinHash,
    totpEnabled: row?.totpEnabled ?? false,
    elo: row?.elo ?? 0,
    eloFfa: row?.eloFfa ?? 0,
    rp: row?.rp1v1 ?? SEASON_START_RP,
    rpFfa: row?.rpFfa ?? SEASON_START_RP,
    season: row?.season ?? 1,
    // PROGRESSION. `xp` is the stored career counter; `level` is DERIVED from
    // it here purely so a client that has not imported the curve still has a
    // number to print. getLevelInfo(xp) on the client yields the same value —
    // the level is never stored, exactly like the rank badge.
    xp: row?.xp ?? 0,
    level: getLevelInfo(row?.xp ?? 0).level,
  })
})

// ─────────────────────────────────────────────────
// POST /api/profile/register  { username, pin }
// ─────────────────────────────────────────────────
const RegisterSchema = z.object({
  username: z.string().regex(USERNAME_REGEX, {
    message: 'Username must be 3–20 characters: letters, numbers, underscore',
  }),
  pin: z.string().regex(PIN_REGEX, { message: 'PIN must be exactly 4 digits' }),
})

profile.post('/register', async (c) => {
  const unconfigured = missingConfig()
  if (unconfigured) return c.json({ error: unconfigured }, 503)
  const db = requireDb()!

  const wallet = c.get('wallet')
  if (registerLimited(`register:${wallet}`)) {
    return c.json({ error: 'Too many attempts — try again later' }, 429)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = RegisterSchema.safeParse(body)
  if (!parsed.success) {
    // First message is the human-readable rule that failed
    const message = parsed.error.issues[0]?.message ?? 'Invalid request'
    return c.json({ error: message }, 400)
  }
  const { username, pin } = parsed.data

  // Once TOTP is enrolled the account is sealed — changing credentials
  // becomes a recovery flow, not a re-register.
  //
  // Reaching this at all means sign-in resolved to an account that is
  // already finished (routes/auth.ts maps every identity a person owns
  // onto one account, so "their" account is the one being described
  // here). The way back in is the PIN + authenticator code they already
  // set up, so say that — and hand the client a `code` it can branch on
  // to open the login form instead of guessing from the wording.
  const [existing] = await db.select().from(users).where(eq(users.wallet, wallet)).limit(1)
  if (existing?.totpEnabled) {
    return c.json(
      {
        error:
          'You already have an account — sign in with your PIN and authenticator code',
        code: 'account_exists',
        username: existing.username,
      },
      409
    )
  }

  // argon2id (Bun's native hasher, OWASP-recommended defaults). The raw
  // PIN is dropped after this line — only the hash is stored.
  const pinHash = await Bun.password.hash(pin, { algorithm: 'argon2id' })

  // Fresh 160-bit secret per enrollment; SHA1/6/30 is the profile every
  // authenticator app (Google Authenticator included) understands.
  const secret = new OTPAuth.Secret({ size: 20 })
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  })
  const otpauthUri = totp.toString()

  // Claim the username. Upsert keyed on wallet (retrying an unfinished
  // enrollment replaces its username/PIN/secret); a unique-index
  // violation that still escapes is the case-insensitive username
  // registry saying "taken".
  let userId: string
  try {
    const [row] = await db
      .insert(users)
      .values({
        wallet,
        username,
        pinHash,
        totpSecret: encryptTotpSecret(secret.base32),
        totpEnabled: false,
      })
      .onConflictDoUpdate({
        target: users.wallet,
        set: {
          username,
          pinHash,
          totpSecret: encryptTotpSecret(secret.base32),
          totpEnabled: false,
          updatedAt: new Date(),
        },
      })
      .returning({ id: users.id })
    userId = row!.id
  } catch (err: unknown) {
    // Postgres 23505 = unique_violation → the username index (the wallet
    // conflict is absorbed by the upsert above). Drizzle wraps the
    // driver error in DrizzleQueryError, so the code can sit on `cause`.
    const code =
      (err as { code?: string })?.code ??
      ((err as { cause?: { code?: string } })?.cause?.code)
    if (code === '23505') {
      return c.json({ error: 'That username is taken — try another' }, 409)
    }
    console.error('register failed:', err)
    return c.json({ error: 'Registration failed — try again' }, 500)
  }

  // Belt and braces on the one-account-per-person rule. Sign-in already
  // linked every identity it verified (services/accountService.ts), but
  // that only ran for sessions minted since identity linking shipped —
  // this makes sure the account is at least reachable by its own wallet
  // whatever route created it. ON CONFLICT DO NOTHING inside, so it is a
  // no-op on the normal path.
  await linkIdentities(userId, [{ kind: 'wallet', value: wallet }])

  // The QR is rendered server-side so the secret never needs a client
  // QR library; classic black-on-white scans most reliably.
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, { width: 280, margin: 2 })

  return c.json({
    username,
    otpauthUri,
    qrDataUrl,
    // base32 for apps that prefer manual entry over scanning
    secret: secret.base32,
  })
})

// ─────────────────────────────────────────────────
// POST /api/profile/totp/verify  { code }
// ─────────────────────────────────────────────────
const VerifyTotpSchema = z.object({
  code: z.string().regex(TOTP_CODE_REGEX, { message: 'Code must be 6 digits' }),
})

profile.post('/totp/verify', async (c) => {
  const unconfigured = missingConfig()
  if (unconfigured) return c.json({ error: unconfigured }, 503)
  const db = requireDb()!

  const wallet = c.get('wallet')
  if (totpLimited(`totp:${wallet}`)) {
    return c.json({ error: 'Too many attempts — try again later' }, 429)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = VerifyTotpSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }

  const [row] = await db.select().from(users).where(eq(users.wallet, wallet)).limit(1)
  if (!row?.totpSecret || !row.username) {
    return c.json({ error: 'Register a username and PIN first' }, 400)
  }
  if (row.totpEnabled) {
    // Enrollment already finished — idempotent success.
    return c.json({ enabled: true, username: row.username })
  }

  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: row.username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(decryptTotpSecret(row.totpSecret)),
  })

  // window:1 accepts the neighbouring 30s steps — tolerates small clock
  // drift between the phone and the server without weakening the code.
  const delta = totp.validate({ token: parsed.data.code, window: 1 })
  if (delta === null) {
    return c.json({ error: 'Invalid code — check your authenticator app' }, 401)
  }

  // Burn the code as well as accepting it. `delta` is an offset in 30s
  // steps from the current one, so this is the absolute step the code
  // belongs to — recording it stops the very same code being replayed at
  // POST /api/auth/login while it is still inside its window.
  const step = Math.floor(Date.now() / 1000 / 30) + delta

  await db
    .update(users)
    .set({ totpEnabled: true, totpLastStep: step, updatedAt: new Date() })
    .where(eq(users.wallet, wallet))

  return c.json({ enabled: true, username: row.username })
})

export default profile
