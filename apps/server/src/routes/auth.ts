/**
 * AUTH ROUTES (Hono)
 * ===================
 * Two ways into an account, both ending in one of OUR session JWTs. Every
 * protected route and socket trusts only that JWT from then on.
 *
 * 1. WALLET SIGN-IN — the everyday path, in two flavours, tried in order:
 *
 *    1a. PRIVY-SESSION SIGN-IN (no wallet popup). Every login in this app
 *        goes through Privy, and Privy already proved wallet ownership at
 *        link time (SIWS for external wallets; embedded wallets are
 *        custodied per user). The client presents the Privy access +
 *        identity tokens; we verify BOTH against Privy's public JWKS
 *        (lib/privyIdentity.ts) and require the claimed wallet to appear
 *        in the identity token's verified `linked_accounts`:
 *          POST /api/auth/verify {wallet,privyToken,privyIdentityToken}
 *                                                   → { token, account }
 *        No nonce is needed: nothing is signed by the client, and the
 *        Privy tokens are short-lived and audience-bound, so a captured
 *        body dies with them. This is the same attestation the account
 *        matcher below already trusts to MERGE accounts — trusting it to
 *        sign in is not a new grant. What it removes is the wallet's
 *        signature UI, the one step with no upper bound: on devices where
 *        the embedded-wallet iframe never comes up, the prompt simply
 *        never appeared and sign-in hung until the 60s client timeout.
 *
 *    1b. NONCE + SIGNATURE (fallback, and the pre-existing path). For
 *        sessions the tokens cannot vouch for — a stale identity token
 *        that does not yet list a just-created wallet, a Privy outage, or
 *        this server running without PRIVY_APP_ID:
 *          a. GET  /api/auth/nonce?wallet=...        → { nonce } (2-min expiry)
 *          b. client signs  "Sign in to Neon Arcade\nNonce: <nonce>"
 *          c. POST /api/auth/verify {wallet,signature,nonce,privyToken?}
 *                                                    → { token, account }
 *
 *        Why a nonce here? Without one, a captured signature could be
 *        replayed forever to mint fresh tokens. The nonce is single-use
 *        and expires in 2 minutes, so a signature is only good for one
 *        sign-in.
 *
 *    Either way:
 *      d. GET  /api/auth/me  (Authorization: Bearer) → the authed user
 *
 * 2. PIN + AUTHENTICATOR — POST /api/auth/login {username,pin,code}.
 *    The credentials set up during account creation, used to reach an
 *    EXISTING account when the wallet route cannot: a Privy login that
 *    produced a different wallet, a new device, a lost embedded wallet.
 *    Proving them also ADOPTS the current Privy identity into the account
 *    (services/accountService.ts), so the wallet path works by itself from
 *    then on and this stays a one-time step rather than a habit.
 *
 * ONE PERSON, ONE ACCOUNT
 * -----------------------
 * A verified signature says which WALLET is calling, not which PERSON —
 * and Privy hands one person several wallets over time. So /verify also
 * takes the Privy tokens, verifies them against Privy's public JWKS
 * (lib/privyIdentity.ts), and resolves the whole identity set to a single
 * account (services/accountService.ts). The JWT is then minted for that
 * account's CANONICAL wallet, which may not be the address that signed.
 * That is deliberate: it is what stops a second wallet from becoming a
 * second account, and what keeps a returning player's username, rank and
 * friends attached to them.
 *
 * STAYING SIGNED IN
 * -----------------
 * Sessions last 30 days and POST /api/auth/refresh mints a fresh one from
 * a still-valid token, so an active player is never asked to sign again.
 * A signature prompt is for NEW devices, not for Tuesday.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { sign } from 'hono/jwt'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import * as OTPAuth from 'otpauth'
import { and, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm'
import {
  SEASON_START_RP,
  buildSignInMessage,
  USERNAME_REGEX,
  PIN_REGEX,
  TOTP_CODE_REGEX,
  TOTP_ISSUER,
} from '@neon/types'
import { config } from '../config/env'
import { requireDb } from '../db'
import { users, nonces } from '../db/schema'
import { requireAuth, type AuthVariables } from '../middleware/requireAuth'
import { decryptTotpSecret } from '../lib/totpCrypto'
import { createRateLimiter } from '../lib/rateLimit'
import { verifyPrivyIdentity } from '../lib/privyIdentity'
import { revokeSessions } from '../lib/sessionRevocation'
import { adoptIdentity, resolveSignIn } from '../services/accountService'

const auth = new Hono<{ Variables: AuthVariables }>()

/**
 * How long a minted session token lives.
 *
 * This used to be 24h, which meant a wallet-signature prompt every single
 * day — the thing that pushed people back through the account screens and
 * made "create an account" feel like the normal way in. 30 days, plus the
 * silent /refresh the client runs on load, means a player who visits at
 * all stays signed in indefinitely and only signs on a genuinely new
 * device. Sign-out still revokes locally by dropping the token, and the
 * account's PIN + authenticator remain the real credentials.
 */
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30

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
/**
 * The Privy JWTs the client may present alongside the signature. Both are
 * OPTIONAL: a client that sends neither still signs in, it just cannot be
 * recognised as someone who already has an account under a different
 * wallet. Length-capped so a huge body can't be used to make the server
 * do JWKS work for nothing.
 */
const PrivyTokenSchema = z.string().min(20).max(8192).optional()

const VerifySchema = z.object({
  wallet: WalletSchema,
  // base58 of a 64-byte ed25519 signature (~86–88 chars). Optional as a
  // PAIR with `nonce`: both present = the signature path, both absent =
  // the Privy-session path. One without the other is a malformed client.
  signature: z.string().min(64).max(120).regex(BASE58).optional(),
  nonce: z.string().uuid().optional(),
  /** Privy access token — carries the stable Privy user id (DID). */
  privyToken: PrivyTokenSchema,
  /** Privy identity token — carries verified emails and linked wallets. */
  privyIdentityToken: PrivyTokenSchema,
})

/**
 * The machine-readable "no" of the Privy-session path. The client treats
 * exactly this code as "fall back to the signature exchange" — anything
 * else (rate limit, malformed body, server misconfiguration) is a real
 * error that a second popup would not fix.
 */
const SIGNATURE_REQUIRED = 'signature_required'

/** Mint a session JWT for `wallet`. The ONLY place tokens are created. */
async function mintSessionToken(wallet: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign(
    { wallet, iat: now, exp: now + TOKEN_TTL_SECONDS },
    config.JWT_SECRET!
  )
}

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
  const { wallet, signature, nonce, privyToken, privyIdentityToken } = parsed.data

  if (rateLimited(`verify:${wallet}`)) {
    return c.json({ error: 'Too many requests — try again later' }, 429)
  }

  // A signature without its nonce (or the reverse) is not a flavour of
  // either path — it is a client bug, and guessing which path was meant
  // would mask it.
  if (!!signature !== !!nonce) {
    return c.json({ error: 'signature and nonce must be sent together' }, 400)
  }

  // ── PATH 1a: PRIVY-SESSION SIGN-IN (no signature) ────────────────────
  // Nothing was signed for us, so the burden of proof sits entirely on
  // the Privy tokens: both must verify against Privy's JWKS, and the
  // identity token's linked_accounts — Privy's own verified record of
  // which wallets this person owns — must include the claimed address.
  // The ACCESS token alone is never enough: it proves who is calling,
  // not that they own `wallet`.
  //
  // Every rejection here uses SIGNATURE_REQUIRED, because every cause
  // (no tokens, unverifiable tokens, stale linked_accounts, no
  // PRIVY_APP_ID on this server) has the same remedy: prove the wallet
  // the old way instead.
  if (!signature || !nonce) {
    let identity = null
    try {
      identity = await verifyPrivyIdentity(privyToken, privyIdentityToken)
    } catch (err) {
      console.warn('[auth] Privy identity check failed on token sign-in:', err)
    }

    if (!identity || !identity.wallets.includes(wallet)) {
      return c.json(
        {
          error: 'This Privy session could not vouch for that wallet — sign with the wallet instead',
          code: SIGNATURE_REQUIRED,
        },
        401
      )
    }

    const account = await resolveSignIn(wallet, identity)
    const token = await mintSessionToken(account.wallet)

    return c.json({
      token,
      account: {
        username: account.username,
        totpEnabled: account.totpEnabled,
        matchedExistingAccount: account.matchedExistingAccount,
      },
    })
  }

  // ── PATH 1b: NONCE + SIGNATURE ───────────────────────────────────────
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

  // ── WHO is this, not just which wallet ──────────────────────────────
  // The signature proved an address. The Privy tokens (verified against
  // Privy's public JWKS — never trusted as sent) say which PERSON that
  // address belongs to, so an existing account can be recognised through
  // a wallet it has never seen. A Privy outage or a client that sends
  // nothing degrades to wallet-only matching rather than failing sign-in.
  let identity = null
  try {
    identity = await verifyPrivyIdentity(privyToken, privyIdentityToken)
  } catch (err) {
    console.warn('[auth] Privy identity check failed, falling back:', err)
  }

  const account = await resolveSignIn(wallet, identity)

  // The token is minted for the ACCOUNT's canonical wallet, which is the
  // signing address only for a first-time account. See accountService.
  const token = await mintSessionToken(account.wallet)

  return c.json({
    token,
    /**
     * The account this sign-in landed on. Sending it here saves the client
     * a round trip AND lets it tell "welcome back" from "let's get you set
     * up" before it renders anything.
     */
    account: {
      username: account.username,
      totpEnabled: account.totpEnabled,
      /** True when we recognised an existing account under another wallet. */
      matchedExistingAccount: account.matchedExistingAccount,
    },
  })
})

// ─────────────────────────────────────────────────
// POST /api/auth/refresh — extend the session
// ─────────────────────────────────────────────────
// The "keep me signed in" half of the story: the client calls this on
// load with its stored token and gets a fresh 30-day one back, so an
// active player's session never lapses and they are never walked past
// the account screens again. A token that has already expired cannot be
// refreshed (requireAuth rejects it) — that is what the wallet signature
// and the PIN + authenticator login are for.
auth.post('/refresh', requireAuth, async (c) => {
  const wallet = c.get('wallet')

  // A renewal endpoint that renews without limit is a free token printer
  // for anyone holding one stolen token. The budget is generous — a real
  // client calls this once per page load — and only exists to bound abuse.
  if (rateLimited(`refresh:${wallet}`)) {
    return c.json({ error: 'Too many requests — try again later' }, 429)
  }

  const db = requireDb()
  const [row] = db
    ? await db
        .select({ username: users.username, totpEnabled: users.totpEnabled })
        .from(users)
        .where(eq(users.wallet, wallet))
        .limit(1)
    : [undefined]

  // The account behind this token is gone (deleted, or a placeholder that
  // was pruned when its owner signed in to their real account). Renewing
  // would keep a session alive for something that no longer exists — let
  // it lapse and make the client sign in again.
  if (db && !row) {
    return c.json({ error: 'This session is no longer valid — sign in again' }, 401)
  }

  const token = await mintSessionToken(wallet)

  return c.json({
    token,
    account: {
      username: row?.username ?? null,
      totpEnabled: row?.totpEnabled ?? false,
      matchedExistingAccount: false,
    },
  })
})

// ─────────────────────────────────────────────────
// POST /api/auth/logout — end EVERY session
// ─────────────────────────────────────────────────
/**
 * Sign out for real.
 *
 * Dropping the token client-side signs you out of one browser. This
 * stamps `users.sessions_valid_from`, which refuses every token minted
 * before now — the other tab, the phone, the copy in a proxy log. With
 * 30-day sessions that difference is the whole point: without it,
 * "disconnect" on a shared machine left a month-long credential behind.
 *
 * Idempotent, and never fails the client: signing out must always appear
 * to succeed, because the browser is going to throw its token away
 * whatever we answer. An account row that no longer exists (a pruned
 * placeholder) simply has nothing to revoke.
 */
auth.post('/logout', requireAuth, async (c) => {
  const wallet = c.get('wallet')
  let revoked = false
  try {
    revoked = await revokeSessions(wallet)
  } catch (err) {
    console.error('[auth] sign-out could not stamp the account:', err)
  }
  return c.json({ ok: true, revoked })
})

// ─────────────────────────────────────────────────
// POST /api/auth/login  { username, pin, code }
// ─────────────────────────────────────────────────
/**
 * Sign in to an EXISTING account with the credentials created during
 * setup: the 4-digit PIN and a 6-digit code from the authenticator app
 * that scanned the QR.
 *
 * This is the answer to "Privy gave me a different wallet and now the
 * arcade wants me to make a second account". Rather than creating one,
 * the player proves the account is theirs and — if they are signed in to
 * Privy — the current Privy identity is adopted into it, so the ordinary
 * wallet path recognises them from then on.
 *
 * SECURITY
 * - Every failure returns the SAME message. Distinguishing "no such user"
 *   from "wrong PIN" would turn this into a username oracle.
 * - The PIN alone is 4 digits (10k combinations). The authenticator code
 *   is what makes this strong; the PIN is the second factor, not the
 *   first. Both are required, always.
 * - Attempts are budgeted per username AND per client address, so neither
 *   spraying one account nor spraying many accounts from one host is
 *   cheap.
 * - An accepted authenticator code is burned (`totp_last_step`), so a
 *   code observed in flight cannot be replayed inside its 30s window.
 */
const LoginSchema = z.object({
  username: z.string().regex(USERNAME_REGEX),
  pin: z.string().regex(PIN_REGEX),
  code: z.string().regex(TOTP_CODE_REGEX),
  privyToken: PrivyTokenSchema,
  privyIdentityToken: PrivyTokenSchema,
})

// Deliberately tighter than the sign-in budget: this endpoint is the one
// place a guessable secret is checked.
const loginLimited = createRateLimiter(15 * 60 * 1000, 10)

/** Same wording for every rejection — see the security note above. */
const LOGIN_FAILED = 'Incorrect username, PIN or authenticator code'

/**
 * A throwaway argon2id hash, verified against whenever the username does
 * not exist. Without it a missing account answers in microseconds while a
 * real one takes ~50ms, and that gap alone enumerates the registry.
 */
const DUMMY_PIN_HASH_PROMISE = Bun.password.hash('0000', { algorithm: 'argon2id' })

/** Best-effort client address for rate-limit bucketing. */
function clientKey(c: { req: { header: (name: string) => string | undefined } }): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || c.req.header('x-real-ip') || 'unknown'
}

auth.post('/login', async (c) => {
  if (!config.JWT_SECRET) {
    console.error('JWT_SECRET is missing — add it to Doppler (≥32 chars)')
    return c.json({ error: 'Auth is not configured on this server' }, 503)
  }
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)
  if (!config.TOTP_ENC_KEY) {
    return c.json({ error: 'TOTP encryption is not configured on this server' }, 503)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = LoginSchema.safeParse(body)
  // A malformed body is answered exactly like wrong credentials: the shape
  // of the failure must not narrow anything down either.
  if (!parsed.success) return c.json({ error: LOGIN_FAILED }, 401)
  const { username, pin, code, privyToken, privyIdentityToken } = parsed.data

  const tooMany =
    loginLimited(`login:user:${username.toLowerCase()}`) ||
    loginLimited(`login:ip:${clientKey(c)}`)
  if (tooMany) {
    return c.json({ error: 'Too many attempts — try again later' }, 429)
  }

  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
    .limit(1)

  // Only a fully enrolled account can be logged into this way: a PIN
  // without a proven authenticator is half a credential.
  const usable = !!(row?.pinHash && row.totpSecret && row.totpEnabled)

  // Always runs an argon2id verify, even for a username that does not
  // exist — see DUMMY_PIN_HASH_PROMISE. A throw here (a corrupt hash) is
  // treated as a failed PIN rather than a 500, which would itself signal
  // that the account is real.
  let pinOk = false
  try {
    pinOk = await Bun.password.verify(
      pin,
      usable ? row!.pinHash! : await DUMMY_PIN_HASH_PROMISE
    )
  } catch {
    pinOk = false
  }
  if (!usable || !pinOk) {
    return c.json({ error: LOGIN_FAILED }, 401)
  }

  // window:1 tolerates small clock drift between the phone and the server.
  // A secret that will not decrypt (rotated TOTP_ENC_KEY, corrupt row) is
  // a server-side problem, and saying so beats a misleading "wrong code".
  let delta: number | null = null
  try {
    const totp = new OTPAuth.TOTP({
      issuer: TOTP_ISSUER,
      label: row!.username!,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(decryptTotpSecret(row!.totpSecret!)),
    })
    delta = totp.validate({ token: code, window: 1 })
  } catch (err) {
    console.error('[auth] could not read the stored TOTP secret:', err)
    return c.json({ error: 'Could not verify your authenticator — contact support' }, 500)
  }
  if (delta === null) return c.json({ error: LOGIN_FAILED }, 401)

  // Burn the code. `delta` is an offset in 30s steps from the current one,
  // so this is the absolute step the code belongs to; anything at or below
  // what the account already spent is a replay.
  //
  // The check IS the write, for the same reason the nonce consume above is
  // one statement: `row` was read before the ~50ms argon2 verify, so
  // comparing against it in JS lets two requests carrying the same code
  // interleave and both pass. Guarding on the column inside the UPDATE
  // means Postgres decides, once, and the loser gets no row back. The
  // `>` in the predicate also keeps the value monotonic, so a late
  // request holding an older code can't wind the counter backwards and
  // un-burn a code that was already spent.
  const step = Math.floor(Date.now() / 1000 / 30) + delta
  const [burned] = await db
    .update(users)
    .set({ totpLastStep: step, updatedAt: new Date() })
    .where(
      and(
        eq(users.id, row!.id),
        or(isNull(users.totpLastStep), lt(users.totpLastStep, step))
      )
    )
    .returning({ id: users.id })

  if (!burned) return c.json({ error: LOGIN_FAILED }, 401)

  // Credentials proven. If they are also signed in to Privy, attach that
  // identity so the plain wallet path finds this account next time.
  if (privyToken) {
    try {
      const identity = await verifyPrivyIdentity(privyToken, privyIdentityToken)
      if (identity) await adoptIdentity(row!.id, null, identity)
    } catch (err) {
      // Linking is a convenience; never fail a proven login over it.
      console.warn('[auth] identity adoption after credential login failed:', err)
    }
  }

  const token = await mintSessionToken(row!.wallet)

  return c.json({
    token,
    account: {
      username: row!.username,
      totpEnabled: true,
      matchedExistingAccount: true,
    },
  })
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

  // RANKED 2.0: `rp`/`rpFfa` are the real ladder numbers; `elo`/`eloFfa`
  // are the legacy mirror rankService keeps in lockstep. See profile.ts /me.
  return c.json({
    wallet,
    username: row?.username ?? null,
    elo: row?.elo ?? 0,
    eloFfa: row?.eloFfa ?? 0,
    rp: row?.rp1v1 ?? SEASON_START_RP,
    rpFfa: row?.rpFfa ?? SEASON_START_RP,
    season: row?.season ?? 1,
  })
})

export default auth
