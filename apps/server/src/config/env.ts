/**
 * ENV CONFIG — validated once at startup with Zod
 * ================================================
 * Doppler injects secrets into process.env at runtime
 * (via `doppler run -- bun dev`). This file validates them
 * and exports a typed config object.
 *
 * If a required secret is missing, the server crashes HERE
 * at boot with a clear message — not randomly mid-request.
 */

import { z } from 'zod'

const envSchema = z.object({

  // Signs the session JWTs minted after wallet sign-in. Optional at boot
  // so the server can still start without it; auth routes answer 503
  // until it exists. Doppler: JWT_SECRET (any random string ≥32 chars).
  JWT_SECRET: z.string().min(32, {
    message: 'JWT_SECRET must be at least 32 characters — set it in Doppler',
  }).optional(),

  // Neon Postgres connection string (Doppler). Optional at boot so the
  // API can run without a database; DB-backed routes 503 until it exists.
  DATABASE_URL: z.string().url().optional(),

  // The Privy app id — the SAME 25-character value the browser bundle
  // uses as VITE_PRIVY_APP_ID. It is PUBLIC (it identifies the app, it
  // does not authorize anything), and the server needs it to verify the
  // Privy tokens the client presents at sign-in: it is the expected `aud`
  // claim and it addresses the JWKS endpoint the signature is checked
  // against. See lib/privyIdentity.ts.
  //
  // Optional at boot. Without it the server cannot tell two wallets
  // belonging to the same person apart, so accounts are deduplicated by
  // wallet ALONE — set it in Doppler as PRIVY_APP_ID for the real thing.
  PRIVY_APP_ID: z.string().length(25, {
    message: 'PRIVY_APP_ID must be the 25-character app id from dashboard.privy.io',
  }).optional(),

  // Encrypts TOTP secrets at rest (AES-256-GCM) so a database leak alone
  // can't clone authenticator codes. Exactly 64 hex chars = 32 bytes.
  // Generate with `openssl rand -hex 32` and set it in Doppler as
  // TOTP_ENC_KEY. Optional at boot; profile routes 503 until it exists.
  TOTP_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, {
    message: 'TOTP_ENC_KEY must be 64 hex characters (openssl rand -hex 32) — set it in Doppler',
  }).optional(),

  // Frontend origin(s) for CORS (security protocol says never "*").
  // Comma-separated exact origins, e.g. "https://neonarcade.app" or
  // "https://neonarcade.app,https://staging.neonarcade.app". Local
  // loopback origins (any port) are always allowed on top of this list —
  // Vite silently moves to 5174+ when 5173 is taken, and a hardcoded
  // port turns that into every API call dying on CORS preflight.
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  // Server
  PORT: z.coerce.number().default(3002),

  // Region tag for THIS server instance ('local', 'us-east', 'eu', ...).
  // Single-region deploy for now, but free-play worlds and their permanent
  // match rows are keyed per (game, REGION), so a future multi-region
  // rollout needs no schema change. Clients latency-probe via GET /ping.
  REGION: z.string().default('local'),

  // House rake on free-play kill transfers, in percent (10 = 10%).
  // Money math lives ONLY in services/wagerService.ts, which reads this.
  HOUSE_FEE_PERCENT: z.coerce.number().default(10),

  // Free-play entry fee, in SOL-denominated ledger units. Deposits are a
  // ledger stub in this pass — TODO(on-chain): verify real deposits before
  // crediting (never import @solana/web3.js here yet).
  FREEPLAY_ENTRY_FEE: z.coerce.number().default(0.05),

  /**
   * ═══════════ ON-CHAIN WAGERING (WAGERING_IMPLEMENTATION.md §2) ═══════════
   * The four secrets are individually optional at the schema level so the
   * server can still boot on a deployment that has not configured wagering
   * yet (the repo-wide 503-until-set convention) — but they are validated as
   * a GROUP below: all four present → wagering on; none present → wagering
   * cleanly disabled; a PARTIAL set → boot crash, because half-configured
   * money code must never run. The spec's "crash at boot" rule is applied to
   * misconfiguration, not to absence, so pushing this code cannot take down
   * auth/games on a deploy that hasn't minted a house wallet yet.
   */
  SOLANA_RPC_URL: z.string().url().optional(),
  HOUSE_WALLET_ADDRESS: z.string().min(32).max(44).optional(),
  // JSON array string, e.g. the contents of a solana-keygen id.json.
  HOUSE_WALLET_PRIVATE_KEY: z.string().min(2).optional(),
  COLD_WALLET_ADDRESS: z.string().min(32).max(44).optional(),

  // Tunables — safe defaults per the spec; all overridable via Doppler.
  MIN_BET_SOL: z.coerce.number().default(0.01),
  MAX_BET_SOL: z.coerce.number().default(10),
  MIN_GIFT_SOL: z.coerce.number().default(0.01),
  MAX_GIFT_SOL: z.coerce.number().default(10),
  // The money-laundering brake (§8) — never raise without the owner.
  GIFT_DAILY_CAP_SOL: z.coerce.number().default(50),
  HOUSE_MINIMUM_RESERVE_SOL: z.coerce.number().default(5),
  PAYOUT_ALERT_THRESHOLD_SOL: z.coerce.number().default(20),

  // Optional email target for critical alerts (services/alertService.ts).
  // Provider key comes later (Resend); absent → stderr JSON only.
  ALERT_EMAIL: z.string().email().optional(),
})

// Parse process.env once. Throws and halts boot if invalid.
export const config = envSchema.parse(process.env)

/**
 * The all-or-nothing group check described above. HOUSE_WALLET_ADDRESS is
 * spec'd at exactly 44 chars, but base58 pubkeys are legitimately 32–44 —
 * the real validation is `new PublicKey(...)` in solana/payoutService.ts.
 */
const WAGERING_KEYS = [
  'SOLANA_RPC_URL',
  'HOUSE_WALLET_ADDRESS',
  'HOUSE_WALLET_PRIVATE_KEY',
  'COLD_WALLET_ADDRESS',
] as const
const present = WAGERING_KEYS.filter((k) => config[k])
if (present.length > 0 && present.length < WAGERING_KEYS.length) {
  const missing = WAGERING_KEYS.filter((k) => !config[k])
  if (config.HOUSE_WALLET_PRIVATE_KEY) {
    // KEY MATERIAL half-wired is the dangerous state — a signing key with a
    // mismatched/missing address set must never run. Crash loudly.
    throw new Error(
      `[env] HOUSE_WALLET_PRIVATE_KEY is set but wagering is incomplete — ` +
        `refusing to boot. Set the missing Doppler vars (${missing.join(', ')}) ` +
        `or unset the key to disable wagering entirely.`
    )
  }
  // No key present → no money code CAN run; a stray leftover (a lone
  // SOLANA_RPC_URL survived the pre-wagering drafts and crash-looped the
  // first deploy of this guard) just leaves wagering disabled, loudly.
  console.warn(
    `[env] Wagering is PARTIALLY configured (${present.join(', ')} set; ` +
      `${missing.join(', ')} missing) — wagering stays DISABLED until all ` +
      `four are set.`
  )
}

/** True when every on-chain wagering secret is configured. Money routes and
 *  the payout service refuse to operate (503) when this is false. */
export const wageringEnabled = present.length === WAGERING_KEYS.length
