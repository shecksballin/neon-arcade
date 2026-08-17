/**
 * PRIVY IDENTITY — proving WHO signed in, not just which wallet
 * ============================================================
 * routes/auth.ts proves that the caller controls a wallet address. That
 * is not enough to keep one person to one account, because Privy hands
 * the same person different wallets depending on how they logged in
 * (embedded wallet from an email login, a second embedded wallet from a
 * Google login, Phantom when they connect it directly). To collapse all
 * of those onto one arcade account we need Privy's own view of the user.
 *
 * WHAT WE VERIFY
 * --------------
 * Privy issues two JWTs to the browser, both ES256-signed by Privy and
 * both verifiable against the app's PUBLIC JWKS — no app secret, and no
 * call to Privy's API on the request path:
 *
 *   ACCESS token  (`getAccessToken()`)  — REQUIRED for identity.
 *     sub = 'did:privy:…', the stable Privy user id. This is the primary
 *     identity key: it survives new wallets, new devices and new browsers.
 *
 *   IDENTITY token (`useIdentityToken()`) — OPTIONAL enrichment.
 *     Same subject, plus `linked_accounts`: the verified emails and
 *     wallets on the Privy user. The emails matter because Privy can
 *     issue TWO DIDs to one human (signing in with email, then with a
 *     Google account carrying that same address, when the app has not
 *     merged them). A shared verified email links those two DIDs to one
 *     arcade account.
 *
 * Both are checked with `iss: 'privy.io'` and `aud: <PRIVY_APP_ID>`, so a
 * token minted for a different Privy app cannot be replayed at us.
 *
 * WHY ONLY VERIFIED FIELDS
 * ------------------------
 * Nothing here reads an email the CLIENT claims. Account linking is a
 * takeover primitive: if we linked on a self-reported address, anyone
 * could type a victim's email and inherit their account. Every value this
 * module returns came out of a signature-checked Privy token.
 *
 * DEGRADED MODE
 * -------------
 * Without PRIVY_APP_ID configured (or without a token from the client)
 * every function returns null. Sign-in still works — accounts are then
 * deduplicated by wallet alone, exactly as they were before this landed.
 */

import { decode, verifyWithJwks } from 'hono/jwt'
import { config } from '../config/env'

/** Privy signs both tokens with ES256 and nothing else is accepted. */
const ALLOWED_ALGORITHMS = ['ES256'] as const

/** Every Privy-issued token carries this issuer. */
const PRIVY_ISSUER = 'privy.io'

/** Privy user ids are DIDs; anything else is not an identity we know. */
const PRIVY_DID_PREFIX = 'did:privy:'

/** Refetch the signing keys at most once an hour on the happy path. */
const JWKS_TTL_MS = 60 * 60 * 1000

/**
 * A JWKS entry as Privy publishes it: a public EC key plus the `kid` the
 * token header names. Spelled out rather than reusing the DOM's
 * `JsonWebKey` because this package does not pull in the DOM lib; the
 * index signature keeps any extra fields Privy adds, since the whole
 * object is handed to `crypto.subtle.importKey` untouched.
 */
interface JsonWebKeyWithKid {
  kid?: string
  kty?: string
  alg?: string
  use?: string
  crv?: string
  x?: string
  y?: string
  [field: string]: unknown
}

/** What one verified Privy session tells us about the person behind it. */
export interface PrivyIdentity {
  /** `did:privy:…` — the stable Privy user id. Always present. */
  did: string
  /** Verified email addresses on the Privy user, lowercased. May be empty. */
  emails: string[]
  /** Wallet addresses Privy lists for the user. May be empty. */
  wallets: string[]
}

// ─────────────────────────────────────────────────
// JWKS CACHE
// ─────────────────────────────────────────────────
// `verifyWithJwks({ jwks_uri })` refetches the key set on EVERY call, which
// would put a Privy round-trip in front of every sign-in. We fetch once,
// hand the keys in ourselves, and only refetch when the cache is stale or
// a token arrives with a `kid` we have never seen (i.e. Privy rotated).

let cachedKeys: JsonWebKeyWithKid[] | null = null
let cachedAt = 0
/** One in-flight fetch shared by concurrent sign-ins. */
let keysInFlight: Promise<JsonWebKeyWithKid[]> | null = null

function jwksUri(appId: string): string {
  return `https://auth.privy.io/api/v1/apps/${appId}/jwks.json`
}

async function fetchKeys(appId: string): Promise<JsonWebKeyWithKid[]> {
  const res = await fetch(jwksUri(appId), {
    // A hung Privy must not hang sign-in; the caller treats a throw as
    // "no identity" and falls back to wallet-only deduplication.
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) {
    throw new Error(`Privy JWKS fetch failed with ${res.status}`)
  }
  const data = (await res.json()) as { keys?: JsonWebKeyWithKid[] }
  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw new Error('Privy JWKS response had no keys')
  }
  return data.keys
}

/**
 * The app's current signing keys.
 *
 * @param force  Skip the cache — used once, after a `kid` miss, so a key
 *               rotation costs one extra fetch instead of an outage.
 */
async function getKeys(appId: string, force = false): Promise<JsonWebKeyWithKid[]> {
  const fresh = cachedKeys && Date.now() - cachedAt < JWKS_TTL_MS
  if (!force && fresh) return cachedKeys!

  // Collapse a thundering herd of sign-ins onto one fetch.
  if (!keysInFlight) {
    keysInFlight = fetchKeys(appId)
      .then((keys) => {
        cachedKeys = keys
        cachedAt = Date.now()
        return keys
      })
      .finally(() => {
        keysInFlight = null
      })
  }
  return keysInFlight
}

/** True when `token`'s `kid` is absent from the cached key set. */
function kidIsUnknown(token: string, keys: JsonWebKeyWithKid[]): boolean {
  try {
    const kid = decode(token).header.kid
    return typeof kid === 'string' && !keys.some((k) => k.kid === kid)
  } catch {
    // Unparseable header — let verifyWithJwks produce the real rejection.
    return false
  }
}

/**
 * Verify one Privy JWT and return its claims, or null if it does not
 * check out. Never throws — a malformed/expired token is a fact about the
 * request, not a server error.
 */
async function verifyPrivyToken(
  token: string,
  appId: string
): Promise<Record<string, unknown> | null> {
  const verification = { iss: PRIVY_ISSUER, aud: appId }

  for (const force of [false, true]) {
    try {
      const keys = await getKeys(appId, force)
      // On the first pass, if the token names a key we do not hold, skip
      // straight to the refetch instead of failing on a stale cache.
      if (!force && kidIsUnknown(token, keys)) continue

      return (await verifyWithJwks(token, {
        keys,
        verification,
        allowedAlgorithms: [...ALLOWED_ALGORITHMS],
      })) as Record<string, unknown>
    } catch (err) {
      // A rotation shows up as "no key matches this kid" — worth one
      // retry with fresh keys. Everything else (bad signature, expired,
      // wrong audience) is final, and retrying would only cost a fetch.
      if (force) {
        console.warn('[privy] token verification failed:', (err as Error)?.message)
        return null
      }
    }
  }
  return null
}

/** Pull the DID out of a verified payload, if it looks like one. */
function readDid(payload: Record<string, unknown>): string | null {
  const sub = payload.sub
  return typeof sub === 'string' && sub.startsWith(PRIVY_DID_PREFIX) ? sub : null
}

/**
 * Emails and wallets out of an identity token's `linked_accounts`.
 *
 * Privy serializes that claim as a JSON *string* (an array of account
 * objects). Shapes vary by account type — email logins carry `address`,
 * OAuth logins carry `email` — so this reads both and ignores anything it
 * does not recognise rather than guessing.
 */
function readLinkedAccounts(payload: Record<string, unknown>): {
  emails: string[]
  wallets: string[]
} {
  const emails = new Set<string>()
  const wallets = new Set<string>()

  const raw = payload.linked_accounts
  let accounts: unknown
  if (typeof raw === 'string') {
    try {
      accounts = JSON.parse(raw)
    } catch {
      return { emails: [], wallets: [] }
    }
  } else {
    accounts = raw
  }
  if (!Array.isArray(accounts)) return { emails: [], wallets: [] }

  for (const entry of accounts) {
    if (!entry || typeof entry !== 'object') continue
    const account = entry as Record<string, unknown>
    const type = typeof account.type === 'string' ? account.type : ''

    if (type === 'wallet') {
      const address = account.address
      if (typeof address === 'string' && address.length > 0) wallets.add(address)
      continue
    }

    // 'email' carries the address in `address`; OAuth providers
    // ('google_oauth', 'apple_oauth', 'github_oauth', …) use `email`.
    const candidate =
      type === 'email'
        ? account.address
        : typeof account.email === 'string'
          ? account.email
          : null

    // A bare `@` check is deliberate: this value is only ever used as an
    // opaque lookup key, and Privy already verified deliverability.
    if (typeof candidate === 'string' && candidate.includes('@')) {
      emails.add(candidate.trim().toLowerCase())
    }
  }

  return { emails: [...emails], wallets: [...wallets] }
}

/**
 * Turn the tokens a browser presented into the verified identity behind
 * them, or null when there is nothing trustworthy to go on.
 *
 * The identity token is optional and strictly additive: it only ever
 * contributes emails/wallets, and only when its subject matches the
 * access token's, so a token belonging to somebody else cannot smuggle
 * their email into this session.
 */
export async function verifyPrivyIdentity(
  accessToken: string | null | undefined,
  identityToken?: string | null
): Promise<PrivyIdentity | null> {
  const appId = config.PRIVY_APP_ID
  if (!appId || !accessToken) return null

  const accessPayload = await verifyPrivyToken(accessToken, appId)
  if (!accessPayload) return null

  const did = readDid(accessPayload)
  if (!did) return null

  const identity: PrivyIdentity = { did, emails: [], wallets: [] }

  if (identityToken) {
    const identityPayload = await verifyPrivyToken(identityToken, appId)
    // Same person, or we ignore it entirely.
    if (identityPayload && readDid(identityPayload) === did) {
      const linked = readLinkedAccounts(identityPayload)
      identity.emails = linked.emails
      identity.wallets = linked.wallets
    }
  }

  return identity
}

/** True when this server is configured to verify Privy identities at all. */
export function privyIdentityConfigured(): boolean {
  return !!config.PRIVY_APP_ID
}
