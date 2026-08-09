/**
 * ENV CONFIG — validated once at startup with Zod
 * ================================================
 * Doppler injects secrets into process.env at runtime
 * (via `doppler run -- bun dev`). This file validates them
 * and exports a typed config object.
 *
 * The OPENROUTER_API_KEY lives ONLY here on the server.
 * It is never imported into any frontend file, so it never
 * reaches the browser bundle.
 *
 * If a required secret is missing, the server crashes HERE
 * at boot with a clear message — not randomly mid-request.
 */

import { z } from 'zod'

const envSchema = z.object({
  // OpenRouter — server-only secret, injected by Doppler
  // Optional at boot so the server can start without it;
  // quiz routes will fail gracefully if missing.
  OPENROUTER_API_KEY: z.string().startsWith('sk-or-', {
    message: 'OPENROUTER_API_KEY missing or malformed — add it to Doppler',
  }).optional(),

  // Optional OpenRouter ranking headers (safe, non-secret)
  OPENROUTER_SITE_URL:  z.string().url().optional(),
  OPENROUTER_SITE_NAME: z.string().optional(),

  // Which model to use — defaults to Poolside Laguna S 2.1 (free tier).
  // Override via Doppler's QUIZ_MODEL if you want a different model.
  QUIZ_MODEL: z.string().default('poolside/laguna-s-2.1:free'),

  // Signs the session JWTs minted after wallet sign-in. Optional at boot
  // so the server can still start without it; auth routes answer 503
  // until it exists. Doppler: JWT_SECRET (any random string ≥32 chars).
  JWT_SECRET: z.string().min(32, {
    message: 'JWT_SECRET must be at least 32 characters — set it in Doppler',
  }).optional(),

  // Neon Postgres connection string (Doppler). Optional at boot so the
  // API can run without a database; DB-backed routes 503 until it exists.
  DATABASE_URL: z.string().url().optional(),

  // Encrypts TOTP secrets at rest (AES-256-GCM) so a database leak alone
  // can't clone authenticator codes. Exactly 64 hex chars = 32 bytes.
  // Generate with `openssl rand -hex 32` and set it in Doppler as
  // TOTP_ENC_KEY. Optional at boot; profile routes 503 until it exists.
  TOTP_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, {
    message: 'TOTP_ENC_KEY must be 64 hex characters (openssl rand -hex 32) — set it in Doppler',
  }).optional(),

  // Exact frontend origin for CORS (security protocol says never "*").
  // Defaults to the local Vite dev server.
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),

  // Server
  PORT: z.coerce.number().default(3002),
})

// Parse process.env once. Throws and halts boot if invalid.
export const config = envSchema.parse(process.env)
