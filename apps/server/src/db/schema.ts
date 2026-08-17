/**
 * DRIZZLE SCHEMA
 * ==============
 * Source of truth for the Neon Postgres database. Push changes with
 * `doppler run -- bun run db:push` (drizzle-kit reads drizzle.config.ts).
 *
 * USERS — one row per ACCOUNT. The row is created the first time a Privy
 * identity signs in (username still null) and filled in when that person
 * registers a name. This is a FRESH registry: usernames start from zero
 * here, and the legacy prototype tables (`players`, `match_history`) were
 * nullified when it landed — no previously-taken name is reserved.
 *
 * `wallet` is the account's CANONICAL wallet: the address minted into
 * every session JWT and the key every other table joins on. It is chosen
 * once, at first sign-in, and never changes — a person who later signs in
 * with a second wallet is resolved back to this same row by
 * `account_identities` (below) rather than getting a second account.
 *
 * Security notes (see routes/profile.ts for the full protocol):
 * - `pin_hash` is an argon2id hash (Bun.password) — the 4-digit PIN is
 *   never stored in plaintext.
 * - `totp_secret` is AES-256-GCM encrypted with TOTP_ENC_KEY (Doppler)
 *   before it touches the database — a DB leak alone can't clone codes.
 * - `username` uniqueness is case-insensitive via the functional unique
 *   index on lower(username): "Vanguard" and "vanguard" are one name.
 */

import { sql, desc } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * RANKED 2.0 COLUMN DEFAULTS — kept in sync with services/trueskill.ts
 * (MU_0 = 25, SIGMA_0 = 25/3) and @neon/types SEASON_START_RP (1000).
 * They are literals here because drizzle needs a constant for the DDL
 * default; if you ever retune the constants, regenerate a migration.
 */
const MU_0_DEFAULT = 25
const SIGMA_0_DEFAULT = 25 / 3 // ≈ 8.333333333333334
const RP_START_DEFAULT = 1000 // Copper V — the season-start RP

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

    /**
     * SIGN-OUT, SERVER SIDE. Epoch SECONDS; every session token issued
     * before this instant is refused.
     *
     * Session JWTs are stateless and now live 30 days, so dropping the
     * browser's copy — which is all "disconnect" used to do — ended the
     * session on that device and nowhere else. A token already copied to
     * another tab, another machine, or a proxy log kept working for a
     * month. POST /api/auth/logout stamps this column instead, and
     * middleware/requireAuth.ts + socket/auth.ts compare it against the
     * token's `iat` (see lib/sessionRevocation.ts).
     *
     * Null means "nothing revoked" — the state every account starts in.
     * Comparison is `iat < sessions_valid_from`, so a token minted in the
     * same second as the sign-out survives; the alternative would reject
     * the fresh token of someone signing straight back in.
     */
    sessionsValidFrom: integer('sessions_valid_from'),

    /**
     * The last TOTP counter step this account successfully spent.
     * A 6-digit code stays valid for its whole 30-second step (plus the
     * ±1 drift window), so without this the same code could be replayed
     * to sign in twice. routes/auth.ts refuses any step <= this value,
     * which makes every code strictly single-use.
     */
    totpLastStep: integer('totp_last_step'),

    /**
     * ═══════════ RATINGS — RANKED 2.0 (two layers, two ladders) ═══════════
     * See services/rankService.ts for the writer and @neon/types/elo.ts for
     * how RP becomes a badge.
     *
     * HIDDEN LAYER — TrueSkill {mu, sigma}. Matchmaking only. NEVER send
     * these to a client: they are the matchmaker's opinion of a player and
     * leaking them would let people shop for soft opponents.
     * VISIBLE LAYER — `rp`, the ladder integer the badge is derived from.
     *
     * Two ladders, one per queue family:
     *   *_1v1 — chess, volley, connect, quiz 1v1
     *   *_ffa — quiz FFA, cells/asteroids LMS, cells/asteroids slayer
     * FREE PLAY IS UNRANKED and must never touch any of these columns.
     */
    mu1v1: doublePrecision('mu_1v1').notNull().default(MU_0_DEFAULT),
    sigma1v1: doublePrecision('sigma_1v1').notNull().default(SIGMA_0_DEFAULT),
    rp1v1: integer('rp_1v1').notNull().default(RP_START_DEFAULT),

    muFfa: doublePrecision('mu_ffa').notNull().default(MU_0_DEFAULT),
    sigmaFfa: doublePrecision('sigma_ffa').notNull().default(SIGMA_0_DEFAULT),
    rpFfa: integer('rp_ffa').notNull().default(RP_START_DEFAULT),

    // Which season the RP columns belong to. Bumped by
    // rankService.rolloverSeason(), which also resets RP and bumps sigma.
    season: integer('season').notNull().default(1),

    /**
     * LEGACY RATING COLUMNS — derived, not authoritative.
     * `rp_1v1` / `rp_ffa` are the source of truth; rankService MIRRORS the
     * new RP into `elo` / `elo_ffa` on every write so the not-yet-migrated
     * readers (leaderboards, social payloads, older clients) keep showing a
     * sane number instead of a stale 0. Never write these directly and never
     * read them for rating maths. Rows created before Ranked 2.0 still hold
     * old ELO values until that wallet plays its first ranked match.
     * TODO(cleanup): drop once every reader uses rp_*.
     */
    elo: integer('elo').notNull().default(0),
    eloFfa: integer('elo_ffa').notNull().default(0),

    /**
     * ═══════════════ XP — THE PROGRESSION LADDER ═══════════════
     * Career experience points. See services/xpService.ts for the writer and
     * @neon/types/xp.ts for the curve that turns this into a LEVEL.
     *
     * NOT A RATING. Unlike rp_*, this is:
     *   • monotonic — it only ever goes up (there is no XP loss anywhere),
     *   • season-proof — rolloverSeason() must NEVER reset it,
     *   • universal — EVERY game and EVERY mode awards it, free play and the
     *     single-player iframe games included, which is exactly why it is one
     *     column and not one per ladder.
     *
     * THE LEVEL IS NOT STORED. It is derived from this integer by
     * getLevelInfo(), the same way a rank badge is derived from RP — storing
     * it would let the two drift the first time the curve is retuned. Ordering
     * by level is ordering by xp, so leaderboards need no extra column.
     */
    xp: integer('xp').notNull().default(0),

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

// ─────────────────────────────────────────────────
// ACCOUNT IDENTITIES — every way one person can prove
// they are the owner of ONE `users` row.
// ─────────────────────────────────────────────────
/**
 * THE "ONE ACCOUNT PER PERSON" INVARIANT LIVES HERE.
 *
 * A single Privy login can hand us more than one wallet address over a
 * person's lifetime: an embedded wallet today, Phantom tomorrow, a second
 * embedded wallet if they sign in with Google instead of the email they
 * used the first time. Keying accounts on the wallet alone therefore let
 * one human collect several arcade accounts. This table fixes that by
 * recording every identity we have ever verified for an account:
 *
 *   kind = 'privy'   value = 'did:privy:…'   the Privy user id (DID)
 *   kind = 'email'   value = 'a@b.com'       a Privy-VERIFIED email, lowercased
 *   kind = 'wallet'  value = '<base58>'      a wallet whose ownership was proven
 *
 * `(kind, value)` is UNIQUE, so an identity can belong to at most one
 * account — the database refuses a second one rather than trusting every
 * caller to remember the check. Sign-in looks up ALL of the presented
 * identities at once (services/accountService.ts): any hit resolves to the
 * existing account and its canonical wallet, and the identities that were
 * not on file yet are linked to it on the way through.
 *
 * NOTHING IN HERE IS PUBLIC. Values are wallets, emails and Privy ids —
 * the same rule as everywhere else applies: never serialize one into a
 * payload addressed to another user.
 */
export const accountIdentities = pgTable(
  'account_identities',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // 'privy' | 'email' | 'wallet'
    kind: text('kind').notNull(),

    // Stored EXACTLY as it will be looked up: emails lowercased by the
    // caller, wallets in their base58 casing (base58 is case-sensitive).
    value: text('value').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The invariant: one identity → one account, enforced by Postgres.
    // Linking is written as INSERT … ON CONFLICT DO NOTHING, so a race
    // between two sign-ins is a no-op rather than an error.
    uniqueIndex('account_identities_kind_value_unique').on(table.kind, table.value),
    // "everything linked to this account" — the backfill path reads it.
    index('account_identities_user_idx').on(table.userId),
  ]
)

export type AccountIdentity = typeof accountIdentities.$inferSelect

/** The identity kinds `account_identities.kind` may hold. */
export type IdentityKind = 'privy' | 'email' | 'wallet'

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
// Ranked 2.0 records BOTH layers here: the visible RP move AND the hidden
// TrueSkill move that caused it. The new columns are NULLABLE so pre-2.0
// rows (and the legacy eloService, which only knows about `elo`) stay
// valid; rankService always fills them in.
// ─────────────────────────────────────────────────
export const eloHistory = pgTable(
  'elo_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Nullable: freeplay kills reference the permanent match row, but a
    // rating write must never fail just because no match id was handy.
    matchId: uuid('match_id'),

    wallet: text('wallet').notNull(),

    // Which game produced the change ('chess', 'trivia', 'cells', ...)
    gameKey: text('game_key').notNull(),

    // The GAME mode that produced it: '1v1' | 'ffa' | 'lms' | 'slayer' |
    // 'quiz_ffa' | 'freeplay'. Note this is the shape of the match, NOT the
    // rating pool — see `ladder` for that.
    mode: text('mode').notNull(),

    /**
     * LEGACY MIRROR of the RP columns below (elo_before/after/change).
     * NOT NULL since 1.0, so rankService writes the RP numbers here too and
     * `elo_change = rp_change` always holds for Ranked 2.0 rows.
     * TODO(cleanup): drop with users.elo.
     */
    eloBefore: integer('elo_before').notNull(),
    eloAfter: integer('elo_after').notNull(),
    eloChange: integer('elo_change').notNull(),

    // ── RANKED 2.0 ────────────────────────────────────────────────
    // Which rating pool moved: '1v1' | 'ffa' (null for legacy rows).
    ladder: text('ladder'),

    // 'win' | 'loss' | 'draw' — the OUTCOME that drove the skill update.
    result: text('result'),

    // VISIBLE layer.
    rpBefore: integer('rp_before'),
    rpAfter: integer('rp_after'),
    rpChange: integer('rp_change'),

    // HIDDEN layer — kept for auditing/tuning the model, never rendered.
    muBefore: doublePrecision('mu_before'),
    muAfter: doublePrecision('mu_after'),
    sigmaBefore: doublePrecision('sigma_before'),
    sigmaAfter: doublePrecision('sigma_after'),

    // True when the demotion shield clamped the loss at the tier floor.
    shielded: boolean('shielded').default(false),

    // Which season this row belongs to (RP is only comparable within one).
    season: integer('season'),

    kills: integer('kills').default(0),
    placement: integer('placement'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // "my rating history, newest first" — the RP graph on the stats panel.
    index('elo_history_wallet_created_idx').on(table.wallet, desc(table.createdAt)),
  ]
)

export type EloHistoryRow = typeof eloHistory.$inferSelect

// ─────────────────────────────────────────────────
// XP EVENTS — append-only record of every XP award.
// One row per (player, match) award. Written only by
// services/xpService.ts.
// ─────────────────────────────────────────────────
/**
 * WHY A LEDGER AND NOT JUST THE COUNTER.
 * `users.xp` answers "what level am I"; this table answers the three things
 * a bare counter cannot:
 *
 *   1. THE "+150 XP" TOAST — the client reads recent rows to show what the
 *      last match paid and why (`breakdown` holds the itemised award).
 *   2. THE DAILY CAP for SELF-REPORTED sessions. The single-player iframe
 *      games (golf, clumsy, pug shooter) have no authoritative server
 *      simulation, so their results arrive from the client and are capped per
 *      day — which requires knowing what today already paid out.
 *   3. AUDIT. XP is monotonic, so a bug that pays twice is otherwise
 *      invisible and permanent; with the ledger it can be found and reversed.
 *
 * Rows are NEVER updated or deleted.
 */
export const xpEvents = pgTable(
  'xp_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Internal key — never returned to another user.
    wallet: text('wallet').notNull(),

    // Nullable and NOT a foreign key, same reasoning as eloHistory.matchId:
    // 1v1 games never create a `matches` row and an XP write must not fail
    // for want of a match id. Non-UUID values are stored as null.
    matchId: uuid('match_id'),

    gameKey: text('game_key').notNull(),
    mode: text('mode').notNull(),

    /** Always POSITIVE — nothing in the system takes XP away. */
    amount: integer('amount').notNull(),

    /**
     * Where the award came from. Drives the daily cap:
     *   'match'         a server-authoritative result (every socket game)
     *   'self_reported' a single-player iframe game the client reported
     */
    source: text('source').notNull().default('match'),

    /** Itemised award as JSON (@neon/types XpBreakdown) — display + audit. */
    breakdown: text('breakdown'),

    // The counter on both sides of this award, so the ledger can be replayed
    // and a double-credit is provable rather than suspected.
    xpBefore: integer('xp_before').notNull(),
    xpAfter: integer('xp_after').notNull(),

    // Derived from xp_before/xp_after at write time. Stored ONLY so a level-up
    // can be found without recomputing the curve over every row; the live
    // level always comes from users.xp.
    levelBefore: integer('level_before').notNull(),
    levelAfter: integer('level_after').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // "my recent XP, newest first" — the toast + the progression feed.
    index('xp_events_wallet_created_idx').on(table.wallet, desc(table.createdAt)),
    // The daily cap query: "what has this wallet self-reported since <time>".
    index('xp_events_wallet_source_idx').on(
      table.wallet,
      table.source,
      desc(table.createdAt)
    ),
  ]
)

export type XpEvent = typeof xpEvents.$inferSelect

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

/**
 * ═════════════════════════════════════════════════
 * SOCIAL + STATS (sidebar, friends, messages, stats)
 * ═════════════════════════════════════════════════
 * SECURITY MODEL — read before touching anything below.
 * A user's WALLET IS PRIVATE. These tables store wallets because the
 * server needs a stable internal key, but a wallet must NEVER leave the
 * server in a payload addressed to another user. The ONLY public
 * identifier is `users.username`:
 *   - resolve username → wallet on the way IN (server side),
 *   - resolve wallet → username on the way OUT,
 *   - never the reverse for a client.
 * Every social/stats query must therefore join `users` and select
 * `username`; selecting a wallet column into a response is a bug.
 */

// ─────────────────────────────────────────────────
// FRIENDS — one row per directed friend request.
// A FRIENDSHIP EXISTS if a row (a,b) OR (b,a) has
// status = 'accepted'; the request direction is kept
// so incoming/outgoing lists can be rendered.
// Removing a friendship DELETES the row so message
// authorization fails closed (no orphan 'accepted').
// ─────────────────────────────────────────────────
export const friends = pgTable(
  'friends',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Who sent the request (internal key — never returned to a client).
    requesterWallet: text('requester_wallet').notNull(),

    // Who received it (internal key — never returned to a client).
    recipientWallet: text('recipient_wallet').notNull(),

    // 'pending' | 'accepted' | 'blocked'
    // 'blocked' blocks BOTH directions (search, friend, message, invite).
    status: text('status').notNull().default('pending'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One directed row per pair: a duplicate request is a DB error, not a
    // second row. (Callers must ALSO check the mirrored (b,a) row before
    // inserting — Postgres can't express "either direction" as a unique.)
    uniqueIndex('friends_pair_unique').on(
      table.requesterWallet,
      table.recipientWallet
    ),
    // Hot path: "my incoming requests" / "am I blocked by X".
    index('friends_recipient_status_idx').on(table.recipientWallet, table.status),
    // NOTE: outgoing lookups ("rows I requested") are already served by the
    // leading column of friends_pair_unique — no extra index needed.
  ]
)

export type Friend = typeof friends.$inferSelect

// ─────────────────────────────────────────────────
// MESSAGES — direct messages between two ACCEPTED
// friends. Authorization is checked on send AND on
// read; a thread is never returned to a non-party.
// Bodies are stored RAW and escaped on render (React
// does this by default — never dangerouslySetInnerHTML).
// ─────────────────────────────────────────────────
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    fromWallet: text('from_wallet').notNull(),
    toWallet: text('to_wallet').notNull(),

    // 1–1000 chars after trim (enforced by zod at the route boundary).
    body: text('body').notNull(),

    // Null until the recipient opens the thread — drives unread badges.
    readAt: timestamp('read_at', { withTimezone: true }),

    // SOFT DELETE ONLY (contract): rows are never hard-deleted, so a
    // deleted message can still be audited. Reads must filter this.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Thread fetch: one direction of a conversation, newest last.
    index('messages_thread_idx').on(
      table.fromWallet,
      table.toWallet,
      table.createdAt
    ),
    // Unread badge count for the sidebar.
    index('messages_to_read_idx').on(table.toWallet, table.readAt),
  ]
)

export type Message = typeof messages.$inferSelect

// ─────────────────────────────────────────────────
// MATCH RESULTS — THE STATS TABLE.
// One row per PLAYER per finished match (so a 1v1
// writes two rows). Written only by services/statsService.ts.
// ─────────────────────────────────────────────────
export const matchResults = pgTable(
  'match_results',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Nullable and NOT a foreign key on purpose: 1v1 games (chess, volley,
    // connect, trivia) never create a `matches` row, and a stats write must
    // never fail because no match id was handy. Same reasoning as
    // eloHistory.matchId. statsService drops non-UUID values (room ids).
    matchId: uuid('match_id'),

    // Internal key — never returned to another user (see security note).
    wallet: text('wallet').notNull(),

    // 'chess' | 'volley' | 'connect' | 'trivia' | 'cells' | 'asteroids'
    // | 'golf' | 'clumsy' | 'pugshooter'
    gameKey: text('game_key').notNull(),

    // '1v1' | 'ffa' | 'slayer' | 'lms' | 'freeplay' | 'quiz_ffa' | …
    // mode = 'freeplay' is the FREE-PLAY marker used by every win-rate
    // query — free play has no win condition, so it is excluded from win
    // rate everywhere and only contributes kills/deaths.
    mode: text('mode').notNull(),

    // 'win' | 'loss' | 'draw' — plus the sentinel 'none' for rows that have
    // NO win condition (free play). 'none' rows are counted for K/D and
    // ignored by every win/loss/draw aggregate.
    result: text('result').notNull(),

    kills: integer('kills').notNull().default(0),
    deaths: integer('deaths').notNull().default(0),
    score: integer('score').notNull().default(0),

    // 1-based finishing position for FFA modes; null for 1v1/free play.
    placement: integer('placement'),

    // The opponent's PUBLIC username (never a wallet). statsService
    // validates this against /^[a-zA-Z0-9_]{3,20}$/ before insert, which
    // structurally prevents a 44-char base58 wallet from landing here.
    opponentUsername: text('opponent_username'),

    durationMs: integer('duration_ms'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Per-game stats for one player.
    index('match_results_wallet_game_idx').on(table.wallet, table.gameKey),
    // Match history (newest first, keyset-paginated).
    index('match_results_wallet_created_idx').on(
      table.wallet,
      desc(table.createdAt)
    ),
    // Leaderboards scoped to one game.
    index('match_results_game_idx').on(table.gameKey),
  ]
)

export type MatchResult = typeof matchResults.$inferSelect

// ─────────────────────────────────────────────────
// NOTIFICATIONS — inbox rows for the sidebar badges.
// ─────────────────────────────────────────────────
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // The RECIPIENT's wallet (internal key — never returned to a client).
    wallet: text('wallet').notNull(),

    // 'friend_request' | 'friend_accepted' | 'message' | 'invite'
    type: text('type').notNull(),

    title: text('title'),
    body: text('body'),

    // JSON blob for type-specific payloads (e.g. {"fromUsername":"neo"}).
    // USERNAMES ONLY — never serialize a wallet in here.
    data: text('data'),

    readAt: timestamp('read_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Unread count + inbox listing for one user.
    index('notifications_wallet_read_idx').on(table.wallet, table.readAt),
  ]
)

export type Notification = typeof notifications.$inferSelect
