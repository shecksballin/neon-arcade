/**
 * API CLIENT
 * ==========
 * Typed fetch wrapper. Every backend route has a matching function here.
 * All hooks import from this — never fetch() directly in a hook.
 */

import type { RankTier } from '@neon/types'

// ─────────────────────────────────────────────────
// RANKED 2.0 — reading RP off a payload
// ─────────────────────────────────────────────────
/**
 * THE MIGRATION RULE FOR EVERY PAYLOAD IN THIS FILE.
 *
 * The visible ladder number is now **RP** (`users.rp1v1` / `users.rpFfa`),
 * and the badge — tier AND division — is derived from it by
 * `getRankInfo(rp)` in @neon/types. The old `elo` / `eloFfa` columns still
 * exist but are now a MIRROR of RP, written by the server for legacy
 * readers only.
 *
 * So every response shape below carries the RP field as OPTIONAL and keeps
 * the legacy one required:
 *
 *   - `rp` present  → use it (server is on the new payload)
 *   - `rp` absent   → fall back to `elo`, which holds the same number
 *
 * That way the client renders correct divisions the moment the server
 * starts sending `rp`, and renders correct divisions BEFORE that too
 * (because the mirror is the same integer) — with no flag day.
 *
 * `rankRpOf` is the one place that decision is made; never read `.elo`
 * directly in a component.
 */
export function rankRpOf(
  row:
    | { rp?: number | null; elo?: number | null }
    | null
    | undefined
): number | null {
  if (!row) return null
  if (typeof row.rp === 'number' && Number.isFinite(row.rp)) return row.rp
  if (typeof row.elo === 'number' && Number.isFinite(row.elo)) return row.elo
  return null
}

// Default matches the Hono server's port (apps/server config/env.ts)
const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3002'

// Shown when a request never reaches the server (down, restarting, no
// internet, CORS). Player-facing wording — the technical detail goes to
// the console. Exported so screens can recognise this exact failure and
// quietly retry it.
export const NETWORK_ERROR_MESSAGE =
  'Connection trouble — check your internet and try again in a moment'

/**
 * Every failed request throws this. `status` is the HTTP status code of
 * the response, or 0 when the request never reached the server at all
 * (network down, CORS, server restarting). Screens branch on it —
 * ErrorScreen turns it into a full status-code error page.
 */
export class ApiError extends Error {
  readonly status: number

  /**
   * The server's machine-readable `code`, when it sent one. Routes attach
   * it where the UI has to BRANCH rather than just display a message —
   * e.g. `account_exists` on register, which means "this person already
   * has an account, open the sign-in form" and would otherwise have to be
   * guessed from the wording.
   */
  readonly code: string | null

  constructor(status: number, message: string, code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

// ─────────────────────────────────────────────────
// BASE FETCHER
// ─────────────────────────────────────────────────
/**
 * How long any one request may take before it is abandoned.
 *
 * `fetch` has NO default timeout: a request to a host that accepts the
 * connection and then goes quiet — a tunnel that dropped, a laptop that
 * slept, a server mid-restart — stays pending essentially forever, and so
 * does whatever the UI was awaiting. That is how a screen ends up spinning
 * on a label with no error and no way back. Everything here answers in
 * milliseconds; 30 seconds is a ceiling, not a target.
 *
 * (Quiz generation is the one genuinely slow call and it does NOT go
 * through this client — see components/Trivia/neonQuizApi.ts.)
 */
const REQUEST_TIMEOUT_MS = 30_000

async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('token')

  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      // A caller-supplied signal wins; nothing passes one today.
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    })
  } catch (err) {
    // Network-level failure (server down, port wrong, CORS) surfaces as
    // an opaque "Failed to fetch" — keep the technical detail for devs,
    // hand players something calmer. A timeout lands here too, and is the
    // same thing from the player's point of view: the server did not
    // answer.
    console.error(`[api] network failure for ${path} (${BASE_URL}):`, err)
    throw new ApiError(0, NETWORK_ERROR_MESSAGE)
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new ApiError(
      res.status,
      err.error ?? 'Request failed',
      typeof err.code === 'string' ? err.code : null
    )
  }

  try {
    return await res.json()
  } catch (err) {
    // 2xx with a non-JSON body — wrong VITE_API_URL (SPA fallback page),
    // proxy or captive-portal HTML. To the player that's the same as not
    // reaching the server; the real cause goes to the console.
    console.error(`[api] non-JSON response for ${path} (${BASE_URL}):`, err)
    throw new ApiError(0, NETWORK_ERROR_MESSAGE)
  }
}

// ─────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────
/**
 * The account a sign-in landed on, returned by every endpoint that mints a
 * session token. Having it inline saves a round trip and — more usefully —
 * lets the UI tell "welcome back" from "let's get you set up" before it
 * renders anything.
 */
export interface SignInAccount {
  username: string | null
  totpEnabled: boolean
  /**
   * True when the server recognised an EXISTING account behind a wallet
   * that account had never been seen with — the one-person-one-account
   * rule doing its job. The wallet that signed is not necessarily the
   * account's canonical wallet; the session token is minted for the
   * account, not for the address.
   */
  matchedExistingAccount: boolean
}

export interface SessionResponse {
  token: string
  account: SignInAccount
}

/** The Privy JWTs handed to the backend as identity evidence. */
export interface PrivyTokenPair {
  accessToken?: string | null
  identityToken?: string | null
}

/** Drops null/undefined tokens so the server's optional schema is happy. */
function privyTokenBody(tokens?: PrivyTokenPair) {
  return {
    ...(tokens?.accessToken ? { privyToken: tokens.accessToken } : {}),
    ...(tokens?.identityToken ? { privyIdentityToken: tokens.identityToken } : {}),
  }
}

export const authApi = {
  getNonce: (wallet: string) =>
    api<{ nonce: string }>(`/api/auth/nonce?wallet=${wallet}`),

  /**
   * Exchange a wallet signature for a session token.
   *
   * The Privy tokens are optional but matter: without them the server can
   * only match on the signing wallet, so someone whose Privy login handed
   * them a NEW address looks like a new person and would be walked into
   * creating a second account.
   */
  verify: (
    wallet: string,
    signature: string,
    nonce: string,
    privyTokens?: PrivyTokenPair
  ) =>
    api<SessionResponse>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({
        wallet,
        signature,
        nonce,
        ...privyTokenBody(privyTokens),
      }),
    }),

  /**
   * Sign in on the strength of the Privy session alone — no nonce, no
   * wallet signature, no popup. The server verifies both tokens against
   * Privy's JWKS and requires the identity token's verified linked
   * wallets to include `wallet`; when it cannot vouch, it answers 401
   * with code `signature_required` and the caller falls back to
   * `verify` above. See useBackendAuth for the ordering.
   */
  verifyWithPrivy: (wallet: string, privyTokens: PrivyTokenPair) =>
    api<SessionResponse>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ wallet, ...privyTokenBody(privyTokens) }),
    }),

  /**
   * Sign in to an existing account with the PIN and the 6-digit code from
   * the authenticator app that scanned the setup QR — the way back in when
   * the wallet path lands on the wrong (or a brand-new) address.
   *
   * Passing the Privy tokens links the current Privy login to the account,
   * so the ordinary wallet sign-in finds it by itself from then on.
   */
  login: (
    username: string,
    pin: string,
    code: string,
    privyTokens?: PrivyTokenPair
  ) =>
    api<SessionResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, pin, code, ...privyTokenBody(privyTokens) }),
    }),

  /**
   * Trade a still-valid session token for a fresh one. Called on load, so
   * a player who keeps visiting is never signed out and never sees a
   * signature prompt on a device they have already used.
   */
  refresh: () => api<SessionResponse>('/api/auth/refresh', { method: 'POST' }),

  /**
   * End every session for this account, not just this browser's.
   *
   * Sessions last 30 days and the token is stateless, so forgetting it
   * locally leaves any other copy — another tab, a phone, a shared
   * machine — working for a month. This revokes them server-side. The
   * caller still tears down locally regardless of the answer.
   */
  logout: () =>
    api<{ ok: true; revoked: boolean }>('/api/auth/logout', { method: 'POST' }),

  /**
   * The JWT's own view of the account. Same RP-vs-legacy-mirror rule as
   * `profileApi.me` — read the ladder number through `rankRpOf`, never
   * `.elo`. (New rank UI should prefer `profileApi.me`, which also carries
   * the season.)
   */
  me: () =>
    api<{
      wallet:    string
      username:  string | null
      /** @deprecated legacy mirror of `rp`. */
      elo:       number
      /** @deprecated legacy mirror of `rpFfa`. */
      eloFfa:    number
      rp?:       number
      rpFfa?:    number
    }>('/api/auth/me'),
}


// ─────────────────────────────────────────────────
// MATCH
// ─────────────────────────────────────────────────
export const matchApi = {
  create: (mode: string, betAmount: number, maxPlayers: number, region?: string) =>
    api<{ matchId: string; nonce: string; depositAddress: string; amountSOL: number }>(
      '/api/match/create', {
        method: 'POST',
        body: JSON.stringify({ mode, betAmount, maxPlayers, region }),
      }
    ),

  join: (matchId: string, nonce: string) =>
    api<{ nonce: string; depositAddress: string; amountSOL: number }>(
      `/api/match/${matchId}/join`, {
        method: 'POST',
        body: JSON.stringify({ nonce }),
      }
    ),

  get: (matchId: string) =>
    api<{ match: any }>(`/api/match/${matchId}`),

  confirmDeposit: (matchId: string, txSig: string, nonce: string) =>
    api<{ success: boolean }>(`/api/match/${matchId}/deposit`, {
      method: 'POST',
      body: JSON.stringify({ txSig, nonce }),
    }),

  resign: (matchId: string) =>
    api<{ success: boolean }>(`/api/match/${matchId}/resign`, {
      method: 'POST',
    }),
}

// ─────────────────────────────────────────────────
// CASH OUT
// ─────────────────────────────────────────────────
export const cashOutApi = {
  manual: (matchId: string) =>
    api<{ payout: number; txSig: string }>(`/api/cashout/${matchId}`, {
      method: 'POST',
    }),

  setAuto: (matchId: string, kills?: number | null, minutes?: number | null, sol?: number | null) =>
    api<{ success: boolean }>(`/api/cashout/${matchId}/auto`, {
      method: 'POST',
      body: JSON.stringify({ kills, minutes, sol }),
    }),
}

// ─────────────────────────────────────────────────
// SOCIAL — friends + direct messages
// ─────────────────────────────────────────────────
/**
 * ‼️ SECURITY: USERNAMES ONLY.
 *
 * A wallet is PRIVATE and must never reach another user. `username` is the
 * one and only public identifier on this platform, so every function below
 * takes and returns usernames — there is deliberately no way to name another
 * player by wallet from the client. The server resolves username → wallet
 * internally (routes/social.ts) and never the reverse.
 *
 * The caller's own identity is never sent either: it comes from the JWT the
 * base fetcher attaches, so a body can't impersonate anyone.
 *
 * (An older draft of this file took wallets — `friendsApi.send(toWallet)`,
 * `messagesApi.get(withWallet)`. Those endpoints were never built; this is
 * the real contract.)
 */

/** Everything one user may learn about another. Note what is NOT here. */
export interface PublicUser {
  username: string
  /** Rank TIER from the 1v1 ladder (packages/types/src/elo.ts). */
  rank: RankTier
  /**
   * The player's RP on the 1v1 ladder. Optional: the tier above is enough to
   * colour a chip, but the DIVISION ("Silver III") can only be derived from
   * RP — so a row without this renders the bare tier. See `rankRpOf`.
   */
  rp?: number
  online: boolean
}

/** A search hit — same as PublicUser plus the ladder number behind the tier. */
export interface SearchUser extends PublicUser {
  /** @deprecated legacy mirror of `rp` — read both through `rankRpOf`. */
  elo: number
}

/** A friend-graph entry. `pending` rows live in incoming/outgoing. */
export interface FriendEntry extends PublicUser {
  status: 'accepted' | 'pending'
}

export interface FriendsList {
  /** Accepted both ways — the only people you may message or invite. */
  friends: FriendEntry[]
  /** Requests sent TO me, waiting on my accept/decline. */
  incoming: FriendEntry[]
  /** Requests I sent, waiting on them (cancel with `removeFriend`). */
  outgoing: FriendEntry[]
}

/** One conversation in the Messages panel's thread list. */
export interface MessageThread extends PublicUser {
  /** Unread messages FROM this person (drives the sidebar badge). */
  unread: number
  /** ISO timestamp of the newest message, or null. */
  lastAt: string | null
  /** Preview of the newest message; null when it fell outside the scan. */
  lastBody: string | null
  lastMine: boolean
}

export interface ThreadList {
  threads: MessageThread[]
  /** Sum of every thread's `unread` — the Messages nav badge. */
  unreadTotal: number
}

/**
 * One chat message. `mine` replaces the sender's identity entirely: the
 * server never serializes a wallet, and the thread is always between me and
 * the username in the URL.
 *
 * `body` is stored RAW and MUST be rendered as text (React escapes by
 * default) — never `dangerouslySetInnerHTML`.
 */
export interface ChatMessage {
  id: string
  mine: boolean
  body: string
  /** ISO timestamp. */
  createdAt: string
}

export interface ThreadPage {
  /** Oldest → newest, ready to render top-to-bottom. */
  messages: ChatMessage[]
  /** Keyset cursor for the page BEFORE this one, or null at the start. */
  nextCursor: string | null
}

export const socialApi = {
  /**
   * Username search. Requires ≥ 2 characters (the server answers with an
   * empty list below that — no enumeration) and returns at most 20 hits.
   */
  search: (q: string) =>
    api<{ users: SearchUser[] }>(`/api/social/search?q=${encodeURIComponent(q)}`),

  /** The whole friend graph in one request: accepted + incoming + outgoing. */
  friends: () => api<FriendsList>('/api/social/friends'),

  /**
   * Send a friend request. Every failure — unknown user, blocked, already
   * friends — returns the SAME generic error on purpose, so the UI must not
   * try to explain why beyond what the server said.
   */
  requestFriend: (username: string) =>
    api<{ ok: true }>('/api/social/friends/request', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),

  /** Accept a request that was sent to me (only the recipient can). */
  acceptFriend: (username: string) =>
    api<{ ok: true }>('/api/social/friends/accept', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),

  /** Decline a request sent to me. Idempotent. */
  declineFriend: (username: string) =>
    api<{ ok: true }>('/api/social/friends/decline', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),

  /**
   * Delete the friendship row in either direction — also how an OUTGOING
   * request is cancelled. Messaging authorization then fails closed.
   */
  removeFriend: (username: string) =>
    api<{ ok: true }>('/api/social/friends/remove', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),

  /** Conversation list + the unread total for the Messages badge. */
  threads: () => api<ThreadList>('/api/social/messages'),

  /**
   * One conversation, newest page first. Requires an accepted friendship —
   * the server answers 403 for "not friends" AND "no such user" alike.
   * Opening a thread marks its messages read server-side.
   */
  thread: (username: string, cursor?: string | null) =>
    api<ThreadPage>(
      `/api/social/messages/${encodeURIComponent(username)}` +
        (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')
    ),

  /** Send a message (1–1000 chars after trim). Pushes `social:message`. */
  sendMessage: (username: string, body: string) =>
    api<{ message: ChatMessage }>(
      `/api/social/messages/${encodeURIComponent(username)}`,
      { method: 'POST', body: JSON.stringify({ body }) }
    ),
}

// ─────────────────────────────────────────────────
// STATS  (GET /api/stats/me | /leaderboard | /history)
// ─────────────────────────────────────────────────
/**
 * ‼️ SECURITY: like socialApi, nothing here takes or returns a wallet.
 *
 *  - `/me` describes the SIGNED-IN account only. There is deliberately no
 *    "someone else's stats" parameter — identity comes from the JWT server
 *    side, so you cannot ask for another player's numbers.
 *  - Leaderboard rows and history `opponentUsername` carry a USERNAME and
 *    nothing that maps back to a wallet.
 */

/** One game's career numbers (server: statsService.GameStats). */
export interface GameStatsRow {
  gameKey: string
  /** Every recorded row, free play included. */
  matches: number
  /** Rows that count toward win rate (free play excluded). */
  rankedMatches: number
  freeplayMatches: number
  wins: number
  losses: number
  draws: number
  /**
   * Percent 0–100 (1dp), or null when there are no ranked matches.
   * Render an em dash for null — never "0%", and never multiply by 100.
   */
  winRate: number | null
  kills: number
  deaths: number
  /** kills / max(deaths, 1), 2dp. Only meaningful when `tracksKd`. */
  kd: number
  /** True for Pug Shooter / Asteroids / Cells (all modes). */
  tracksKd: boolean
}

export interface StatsMe {
  /** Echo of the requested filter ('all' or one gameKey). */
  gameKey: string
  /** One row per game actually played, busiest first. */
  perGame: GameStatsRow[]
  /** Totals across exactly those rows. */
  combined: GameStatsRow
  /** The games whose K/D is meaningful — server's KD_GAMES. */
  kdGames: string[]
}

export interface LeaderboardRow {
  /** 1-based position within the returned page. */
  rank: number
  /** The ONLY identifier on the board. */
  username: string
  /** K/D (2dp) or win-rate percent (1dp), matching `metric`. */
  value: number
  /** Sample size behind `value`. */
  matches: number
  /** Rank tier from the ladder matching the metric (1v1 for win rate, FFA for K/D). */
  tier: RankTier
  /**
   * RP behind `tier`, when the server sends it. Without it the chip shows
   * the tier alone — a division cannot be invented client-side.
   */
  rp?: number
}

/** One row of the XP board (metric 'xp'). Ranked by career XP = by level. */
export interface XpLeaderboardRow {
  rank: number
  /** The ONLY identifier on the board. */
  username: string
  xp: number
  level: number
  /** Cosmetic band ("Veteran") and its colour, from the shared curve. */
  band: string
  color: string
}

export interface LeaderboardResponse {
  metric: 'kd' | 'winrate' | 'xp'
  gameKey: string
  /** True for win rate — free play has no win condition. */
  excludesFreeplay: boolean
  /** Minimum matches to qualify. Surface this in the UI (the contract asks). */
  minMatches: number
  rows: LeaderboardRow[]
}

/**
 * The XP board. Same endpoint, `metric=xp`, but the rows are a different
 * shape — so it gets its own response type and its own call rather than a
 * union every consumer would have to narrow.
 */
export interface XpLeaderboardResponse {
  metric: 'xp'
  gameKey: 'all'
  excludesFreeplay: false
  /** Always 0 — every player with XP qualifies. */
  minMatches: number
  rows: XpLeaderboardRow[]
}

/** One finished match, from the signed-in player's point of view. */
export interface HistoryRow {
  gameKey: string
  mode: string
  /** 'none' for free play — render a dash there, NEVER a loss. */
  result: 'win' | 'loss' | 'draw' | 'none'
  kills: number
  deaths: number
  score: number
  placement: number | null
  /** Public username, or null (free play / bots / unregistered). */
  opponentUsername: string | null
  durationMs: number | null
  /** ISO timestamp (serialized from a Date by Hono). */
  createdAt: string

  // ── RANKED 2.0 (optional — only ranked rows have them) ──────────────
  /** Which ladder the match settled on, or null/absent when unranked. */
  ladder?: '1v1' | 'ffa' | null
  /** RP won or lost on this match (signed). Absent on unranked rows. */
  rpChange?: number | null
  /** RP after the match settled — drives the badge shown on the row. */
  rpAfter?: number | null
  /** True when the demotion shield clamped the loss at the tier floor. */
  shielded?: boolean | null
}

export interface HistoryPage {
  matches: HistoryRow[]
  /** Opaque keyset cursor; null when the list is exhausted. */
  nextCursor: string | null
}

// ── XP / LEVELS ───────────────────────────────────────────────────────
/**
 * PROGRESSION. XP is the sibling of RP and behaves the opposite way on
 * purpose: every game and every mode awards it (free play and the
 * single-player games included), a loss still pays, it never falls, and it
 * survives a season rollover. The LEVEL is derived from the XP total by
 * `getLevelInfo` out of @neon/types — never stored, never sent as truth.
 */

/** Itemised award for one match (server: @neon/types XpBreakdown). */
export interface XpBreakdownRow {
  participation: number
  outcome: number
  kills: number
  placement: number
  score: number
  subtotal: number
  total: number
  /** True when the match was too short to pay participation/outcome XP. */
  tooShort: boolean
}

/** What one award did — the "+150 XP" read-out. */
export interface XpAward {
  amount: number
  xpBefore: number
  xpAfter: number
  levelBefore: number
  levelAfter: number
  leveledUp: boolean
  /** Full level read-out after the award (@neon/types LevelInfo). */
  level: {
    xp: number
    level: number
    xpIntoLevel: number
    xpForLevel: number
    xpToNextLevel: number
    progressPct: number
    isMaxLevel: boolean
    band: string
    color: string
    label: string
  }
  breakdown: XpBreakdownRow | null
  /** Present only when the daily self-reported cap clamped the award. */
  cappedBy?: number
}

/** One row of the progression feed. */
export interface XpEventRow {
  gameKey: string
  mode: string
  amount: number
  /** 'self_reported' rows come from the single-player iframe games. */
  source: 'match' | 'self_reported'
  breakdown: XpBreakdownRow | null
  levelBefore: number
  levelAfter: number
  leveledUp: boolean
  /** ISO timestamp. */
  createdAt: string
}

export interface XpSummary {
  xp: number
  level: XpAward['level']
  recent: XpEventRow[]
  /** XP earned in the last 24h, all sources. */
  earnedToday: number
  /** The metering on unverifiable single-player results. */
  selfReported: { dailyCap: number; remaining: number }
}

/**
 * A finished round of a game the SERVER does not simulate (golf, clumsy, pug
 * shooter). Everything here is clamped and metered server-side — see the
 * endpoint's header in apps/server/src/routes/stats.ts. It awards XP and
 * writes a stats row; it can never touch RP.
 */
export interface SessionReport {
  /**
   * The iframe games report every mode; chess/connect/volley/kickoff and
   * asteroids/cells may ONLY report practice (vs-AI) rounds — the server
   * forces mode 'practice' and zeroes kills/placement for them, and
   * practice rows never count toward win rate. Online results still arrive
   * exclusively through the socket handlers.
   */
  gameKey:
    | 'golf'
    | 'clumsy'
    | 'pugshooter'
    | 'chess'
    | 'connect'
    | 'volley'
    | 'kickoff'
    | 'asteroids'
    | 'cells'
  mode?: '1v1' | 'practice' | 'ffa' | 'freeplay'
  result?: 'win' | 'loss' | 'draw' | 'none'
  kills?: number
  deaths?: number
  score?: number
  placement?: number | null
  durationMs?: number | null
}

export const statsApi = {
  /**
   * Career stats. Ask for 'all' and you get BOTH halves of the Stats panel's
   * toggle (per-game rows + combined totals) from one request.
   */
  me: (gameKey: string = 'all') =>
    api<StatsMe>(`/api/stats/me?gameKey=${encodeURIComponent(gameKey)}`),

  /** Top N (max 100) by K/D or win rate, optionally for a single game. */
  leaderboard: (
    metric: 'kd' | 'winrate' = 'winrate',
    gameKey: string = 'all',
    limit = 100
  ) =>
    api<LeaderboardResponse>(
      `/api/stats/leaderboard?metric=${metric}` +
        `&gameKey=${encodeURIComponent(gameKey)}&limit=${limit}`
    ),

  /** Recent matches, newest first. Pass `nextCursor` back to page. */
  history: (limit = 50, cursor?: string | null) =>
    api<HistoryPage>(
      `/api/stats/history?limit=${limit}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
    ),

  /** Career XP, the derived level, and the most recent awards. */
  xp: () => api<XpSummary>('/api/stats/xp'),

  /** Top N (max 100) by career XP — i.e. by level, arcade-wide. */
  xpLeaderboard: (limit = 100) =>
    api<XpLeaderboardResponse>(
      `/api/stats/leaderboard?metric=xp&limit=${limit}`
    ),

  /**
   * Report a finished round of a game the server does not simulate, so it
   * earns XP like everything else.
   *
   * Fire-and-forget from the iframe wrappers: a failed report costs the
   * player some XP, and must never interrupt their exit back to the lobby.
   */
  reportSession: (session: SessionReport) =>
    api<{ recorded: boolean; award: XpAward | null }>('/api/stats/session', {
      method: 'POST',
      body: JSON.stringify(session),
    }),
}

// ─────────────────────────────────────────────────
// LEGACY SOCIAL ALIASES
// ─────────────────────────────────────────────────
/**
 * Thin username-based wrappers kept ONLY so the older `hooks/useApi.ts`
 * helpers keep compiling. New code should import `socialApi` directly;
 * delete this block together with those hooks.
 */
export const friendsApi = {
  list: socialApi.friends,
  send: socialApi.requestFriend,
  accept: socialApi.acceptFriend,
  decline: socialApi.declineFriend,
  remove: socialApi.removeFriend,

  /**
   * Wager duels / match invites are NOT part of this pass (the platform is
   * money-free) and no such endpoint exists. Kept as an explicit rejection
   * so a stray caller fails loudly instead of hitting a 404 and looking
   * like a network problem.
   */
  duel: (_username: string, _betAmount: number): Promise<never> =>
    Promise.reject(new ApiError(501, 'Wager duels are not available')),

  invite: (_username: string, _matchId: string): Promise<never> =>
    Promise.reject(new ApiError(501, 'Match invites moved to the private-wager socket flow')),
}

export const messagesApi = {
  get: socialApi.thread,
  send: socialApi.sendMessage,
}

// ─────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────
export const notificationsApi = {
  list: () =>
    api<{ notifications: any[] }>('/api/notifications'),

  unreadCount: () =>
    api<{ count: number }>('/api/notifications/unread-count'),

  markRead: (id: string) =>
    api<{ success: boolean }>(`/api/notifications/${id}/read`, { method: 'POST' }),

  markAllRead: () =>
    api<{ success: boolean }>('/api/notifications/read-all', { method: 'POST' }),

  setEnabled: (enabled: boolean) =>
    api<{ success: boolean }>('/api/notifications/settings', {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
}

// ─────────────────────────────────────────────────
// LEADERBOARD + PROFILE
// ─────────────────────────────────────────────────

/**
 * GET /api/profile/me — MY account (the sign-in gate reads it, and the
 * sidebar draws my rank card from it).
 *
 * `elo`/`eloFfa` are the legacy mirror of `rp`/`rpFfa` (see `rankRpOf` at
 * the top of this file). Read the pair through `rankRpOf`, never `.elo`.
 *
 * The hidden TrueSkill layer (mu/sigma) is deliberately NOT here and must
 * never be: it would expose matchmaking.
 */
export interface ProfileMe {
  wallet:      string
  username:    string | null
  hasPin:      boolean
  totpEnabled: boolean
  /** @deprecated legacy mirror of `rp` (1v1 ladder). */
  elo:         number
  /** @deprecated legacy mirror of `rpFfa`. */
  eloFfa:      number
  /** Visible RP on the 1v1 ladder (chess / volley / connect / quiz 1v1). */
  rp?:         number
  /** Visible RP on the FFA ladder (quiz FFA, LMS, slayer). */
  rpFfa?:      number
  /** Ranked season this RP belongs to (RP resets to 1000 on rollover). */
  season?:     number
  /**
   * PROGRESSION — career XP across every game (see @neon/types/xp.ts).
   * Unlike RP this never falls and never resets on a season rollover.
   * Pass it to `getLevelInfo(xp)` for the level, band and progress bar;
   * `level` below is the server's copy of the same derivation, for surfaces
   * that only need the number.
   */
  xp?:         number
  level?:      number
}


// ─────────────────────────────────────────────────
// COMMUNITY — the public board (posts + open 1v1 challenges)
// ─────────────────────────────────────────────────

export interface CommunityPost {
  id: string;
  /** Author. USERNAMES ONLY — the server never serves a wallet. */
  username: string;
  kind: 'post' | 'challenge';
  body: string;
  gameKey: string | null;
  mode: string | null;
  roomId: string | null;
  /**
   * Challenge liveness, answered by the server's in-memory room registry:
   * 'open' = the seat is free (JOIN works), 'full' = taken / starting,
   * 'gone' = the host left. Always null for kind 'post'.
   */
  state: 'open' | 'full' | 'gone' | null;
  createdAt: string;
  /** True when the signed-in account wrote it (enables the delete button). */
  mine: boolean;
}

export const communityApi = {
  list: () => api<{ posts: CommunityPost[] }>('/api/community'),

  createPost: (body: string) =>
    api<{ ok: true; id: string }>('/api/community', {
      method: 'POST',
      body: JSON.stringify({ kind: 'post', body }),
    }),

  /** `roomId` must be an OPEN room the caller is hosting (server-verified). */
  createChallenge: (input: { gameKey: string; mode: string; roomId: string; body: string }) =>
    api<{ ok: true; id: string }>('/api/community', {
      method: 'POST',
      body: JSON.stringify({ kind: 'challenge', ...input }),
    }),

  remove: (id: string) =>
    api<{ ok: true }>(`/api/community/${id}`, { method: 'DELETE' }),
};

export const profileApi = {
  get: (wallet: string) =>
    api<{ user: any; eloHistory: any[] }>(`/api/profile/${wallet}`),

  leaderboard: (mode: '1v1' | 'ffa' | 'server') =>
    api<{ players: any[] }>(`/api/leaderboard?mode=${mode}`),

  // NOTE: no updateUsername — usernames are unique, claimed once at
  // registration, and immutable thereafter.

  /** Account status for the sign-in gate: has this wallet finished setup? */
  me: () => api<ProfileMe>('/api/profile/me'),

  /** Claim a unique username + 4-digit PIN; returns the TOTP QR to scan. */
  register: (username: string, pin: string) =>
    api<{
      username:   string
      otpauthUri: string
      qrDataUrl:  string
      secret:     string
    }>('/api/profile/register', {
      method: 'POST',
      body: JSON.stringify({ username, pin }),
    }),

  /** Prove a 6-digit code from the authenticator app to finish enrollment. */
  verifyTotp: (code: string) =>
    api<{ enabled: boolean; username: string }>('/api/profile/totp/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
}

// ─────────────────────────────────────────────────
// GIFT
// ─────────────────────────────────────────────────
export const giftApi = {
  getNonce: () =>
    api<{ nonce: string }>('/api/gift/nonce'),

  send: (toWallet: string, amountSol: number, txSig: string, nonce: string) =>
    api<{ payout: number; txSig: string }>('/api/gift', {
      method: 'POST',
      body: JSON.stringify({ toWallet, amountSol, txSig, nonce }),
    }),
}

// ─────────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────────
export const reportApi = {
  submit: (type: string, body: string, reportedWallet?: string, matchId?: string) =>
    api<{ success: boolean }>('/api/reports', {
      method: 'POST',
      body: JSON.stringify({ type, body, reportedWallet, matchId }),
    }),
}
