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
  numeric,
  timestamp,
  index,
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

/**
 * MONEY COLUMNS — `numeric(18, 9)` everywhere.
 * Postgres `numeric` gives exact decimal arithmetic (SOL has 9 decimal
 * places — lamports — so scale 9 is lossless). Drizzle maps `numeric`
 * to a STRING in TypeScript; all pot math happens in SQL via
 * `sql\`current_pot + ${x}\`` fragments (see services/wagerService.ts),
 * never as JS floats. Precision 18 leaves room for absurdly large pots.
 */

// ─────────────────────────────────────────────────
// MATCHES — one row per game session (or one PERMANENT
// row per (freeplay game, region) that never settles).
// ─────────────────────────────────────────────────
export const matches = pgTable('matches', {
  id: uuid('id').defaultRandom().primaryKey(),

  // Which game this match is for:
  // 'chess' | 'volley' | 'connect' | 'trivia' | 'cells' | 'asteroids'
  gameId: text('game_id').notNull(),

  // Player-count shape: '1v1' | 'ffa'
  mode: text('mode').notNull(),

  // Wager ruleset: '1v1' | 'quiz_ffa' | 'freeplay'
  gameMode: text('game_mode').notNull(),

  // 'open' | 'active' | 'settling' | 'settled' | 'cancelled'
  // (freeplay matches live at 'active' forever)
  status: text('status').notNull().default('active'),

  // Sum of everything deposited into this match (ledger units = SOL)
  totalPot: numeric('total_pot', { precision: 18, scale: 9 }).default('0'),

  // House-fee accumulator — kills tithe into this (see wagerService)
  houseTotal: numeric('house_total', { precision: 18, scale: 9 }).default('0'),

  // Winning wallet for settled 1v1/ffa matches; null for freeplay/draws
  winner: text('winner'),

  // Buy-in (1v1 stake, or FREEPLAY_ENTRY_FEE for the permanent rows)
  betAmount: numeric('bet_amount', { precision: 18, scale: 9 }).default('0'),

  // Which regional instance owns this match ('local' in dev)
  region: text('region').default('local'),

  minPlayers: integer('min_players').default(2),
  maxPlayers: integer('max_players').default(2),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})

export type Match = typeof matches.$inferSelect

// ─────────────────────────────────────────────────
// MATCH PLAYERS — one row per (match, wallet) session.
// The per-player pot ledger for free play lives here.
// ─────────────────────────────────────────────────
export const matchPlayers = pgTable(
  'match_players',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    wallet: text('wallet').notNull(),

    // What the player paid to enter (stubbed ledger credit for now —
    // TODO(on-chain): verify a real deposit transaction instead)
    depositSol: numeric('deposit_sol', { precision: 18, scale: 9 })
      .notNull()
      .default('0'),

    // Live pot — the ONLY source of truth for what this player holds.
    // In-memory copies in the game worlds are render cache only.
    currentPot: numeric('current_pot', { precision: 18, scale: 9 })
      .notNull()
      .default('0'),

    kills: integer('kills').notNull().default(0),

    // 'deposited' | 'active' | 'cashing_out' | 'eliminated' | 'cashed_out'
    // Status transitions are guarded in SQL (atomic claim patterns) so
    // two code paths can never pay the same pot twice.
    status: text('status').notNull().default('active'),

    // Wallet of the killer, when a player was eliminated by another
    eliminatedBy: text('eliminated_by'),

    // Lobby-preset auto-cash-out threshold in SOL (null = manual only)
    autoCashOutSol: numeric('auto_cash_out_sol', { precision: 18, scale: 9 }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // A wallet may hold at most ONE live session across all matches.
    // The PARTIAL unique index turns a double-join race into a DB error
    // the server maps to freeplay:error {code:'already_active'}.
    uniqueIndex('one_active_session_per_wallet')
      .on(table.wallet)
      .where(sql`status = 'active'`),
    // Hot path: "all active players in match X" (kill/settle queries)
    index('match_players_match_status_idx').on(table.matchId, table.status),
  ]
)

export type MatchPlayer = typeof matchPlayers.$inferSelect

// ─────────────────────────────────────────────────
// PAYOUTS — append-only record of money leaving a match.
// ─────────────────────────────────────────────────
export const payouts = pgTable('payouts', {
  id: uuid('id').defaultRandom().primaryKey(),
  matchId: uuid('match_id').notNull(),
  wallet: text('wallet').notNull(),
  amountSol: numeric('amount_sol', { precision: 18, scale: 9 }).notNull(),

  // 'win' | 'cashout' | 'refund' | 'house'
  type: text('type').notNull(),

  // On-chain transaction signature. UNIQUE so a signature can never be
  // recorded twice (double-payout protection); NULL while payouts are
  // ledger-only — TODO(on-chain): fill when real transfers land.
  // (Postgres unique constraints permit multiple NULLs.)
  txSig: text('tx_sig').unique(),

  paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Payout = typeof payouts.$inferSelect

// ─────────────────────────────────────────────────
// ELO HISTORY — one row per rating change per player.
// ─────────────────────────────────────────────────
export const eloHistory = pgTable('elo_history', {
  id: uuid('id').defaultRandom().primaryKey(),

  // Nullable: freeplay kills reference the permanent match row, but a
  // rating write must never fail just because no match id was handy.
  matchId: uuid('match_id'),

  wallet: text('wallet').notNull(),

  // Which game produced the change ('chess', 'trivia', 'cells', ...)
  gameKey: text('game_key').notNull(),

  // '1v1' | 'ffa' | 'freeplay' — which rating pool was touched
  mode: text('mode').notNull(),

  eloBefore: integer('elo_before').notNull(),
  eloAfter: integer('elo_after').notNull(),
  eloChange: integer('elo_change').notNull(),

  kills: integer('kills').default(0),
  placement: integer('placement'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type EloHistoryRow = typeof eloHistory.$inferSelect

// ─────────────────────────────────────────────────
// NONCES — single-use sign-in challenges (routes/auth.ts).
// DB-backed so they survive restarts and shared instances;
// consumed atomically by setting used_at (never deleted mid-flight).
// ─────────────────────────────────────────────────
export const nonces = pgTable('nonces', {
  nonce: text('nonce').primaryKey(),
  wallet: text('wallet').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
})

export type Nonce = typeof nonces.$inferSelect
