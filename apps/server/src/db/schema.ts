/**
 * DRIZZLE SCHEMA
 * ==============
 * Source of truth for the Neon Postgres database. Push changes with
 * `doppler run -- bun run db:push` (drizzle-kit reads drizzle.config.ts).
 *
 * USERS — one row per wallet, created the first time a signed-in wallet
 * registers a username. This is a FRESH registry: usernames start from
 * zero here, and the legacy prototype tables (`players`, `match_history`)
 * were nullified when it landed — no previously-taken name is reserved.
 *
 * Security notes (see routes/profile.ts for the full protocol):
 * - `pin_hash` is an argon2id hash (Bun.password) — the 4-digit PIN is
 *   never stored in plaintext.
 * - `totp_secret` is AES-256-GCM encrypted with TOTP_ENC_KEY (Doppler)
 *   before it touches the database — a DB leak alone can't clone codes.
 * - `username` uniqueness is case-insensitive via the functional unique
 *   index on lower(username): "Vanguard" and "vanguard" are one name.
 */

import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // The verified Solana address from the session JWT — the ONLY
    // identity the API trusts (set by requireAuth, never from a body).
    wallet: text('wallet').notNull().unique(),

    // Display casing preserved; uniqueness enforced case-insensitively
    // by the functional index below. Null until the user registers.
    username: text('username'),

    // argon2id hash of the 4-digit account PIN (Bun.password.hash)
    pinHash: text('pin_hash'),

    // AES-256-GCM-encrypted TOTP secret, base64( iv | ciphertext | tag ).
    // Enabled only after the user proves a code from their authenticator.
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),

    // Ratings — fresh accounts start at 0 (Copper), per the handoff doc.
    elo: integer('elo').notNull().default(0),
    eloFfa: integer('elo_ffa').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Case-insensitive uniqueness: two rows may not share lower(username)
    uniqueIndex('users_username_lower_unique').on(sql`lower(${table.username})`),
  ]
)

export type User = typeof users.$inferSelect
