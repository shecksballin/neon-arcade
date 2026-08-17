/**
 * SOCIAL ROUTES (Hono) — friend graph + direct messages
 * =====================================================
 * Everything the sidebar's Friends and Messages panels talk to.
 *
 * ‼️ SECURITY MODEL — read this before changing a single line
 * -----------------------------------------------------------
 * A user's WALLET IS PRIVATE and must NEVER reach another user. The ONLY
 * public identifier on this platform is `users.username`. That rule shapes
 * every handler in this file:
 *   - the caller's identity is ALWAYS `c.get('wallet')` (verified JWT via
 *     requireAuth). A wallet in a body/param/query is never trusted, and
 *     in fact no endpoint here even ACCEPTS a wallet as input;
 *   - usernames resolve to wallets on the way IN (server side only) and
 *     wallets resolve back to usernames on the way OUT. Selecting a wallet
 *     column into a response body is a bug — the projections below list
 *     their columns explicitly so that can't happen by accident;
 *   - every payload about another person carries at most
 *     `{ username, rank, elo, online, status }`.
 *
 * The other mandatory controls, and where they live:
 *   AUTHORIZATION  messages require an `accepted` friendship, checked on
 *                  SEND *and* on THREAD READ (requireAcceptedFriend). A
 *                  removed friendship deletes the row, so authorization
 *                  fails closed the moment a friendship ends.
 *   VALIDATION     Zod on every body, param and query. Usernames must match
 *                  USERNAME_REGEX (`/^[A-Za-z0-9_]{3,20}$/`, the charset the
 *                  contract pins as `[a-zA-Z0-9_]{3,20}`); message bodies are
 *                  1–1000 chars AFTER trim; search queries are 2–20 chars.
 *   RATE LIMITS    per-wallet, via lib/rateLimit.ts — search 20/min, friend
 *                  requests 20/min, messages 30/min (contract numbers).
 *   NO ENUMERATION search needs >= 2 chars, returns at most 20 prefix/exact
 *                  matches, and NEVER lists the whole table. Friend-request
 *                  failures all return ONE generic error; message endpoints
 *                  answer 403 for "no such user" and "not your friend"
 *                  alike, so neither can be told apart from outside.
 *   SELF / BLOCKED you cannot friend or message yourself, and a `blocked`
 *                  row kills the relationship in BOTH directions.
 *   XSS            bodies are stored RAW and escaped at render time by
 *                  React. Never dangerouslySetInnerHTML on the client.
 *   SOFT DELETE    messages carry `deletedAt`; reads filter it, nothing here
 *                  ever hard-deletes a message.
 *
 * Realtime: this module owns no sockets. It pushes through the small
 * `setSocialRealtime()` bridge below, which the socket layer registers —
 * see the note on that function.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { USERNAME_REGEX, getRankInfo } from '@neon/types'
import type { RankTier } from '@neon/types'
import { requireDb } from '../db'
import { friends, messages, users } from '../db/schema'
import { requireAuth, type AuthVariables } from '../middleware/requireAuth'
import { createRateLimiter } from '../lib/rateLimit'

const social = new Hono<{ Variables: AuthVariables }>()

// Every social route is about the signed-in account — no anonymous reads.
social.use('*', requireAuth)

// ─────────────────────────────────────────────────
// CONSTANTS + RATE LIMITS (contract numbers)
// ─────────────────────────────────────────────────

/** Search: >= 2 chars (no enumeration), <= 20 (a username can't be longer). */
const SEARCH_MIN = 2
const SEARCH_MAX = 20
/** Hard cap on search results — never "list all users". */
const SEARCH_LIMIT = 20

/** Message page sizes. */
const MESSAGES_DEFAULT_LIMIT = 50
const MESSAGES_MAX_LIMIT = 100

/** Thread-list cap (the Messages panel's conversation list). */
const THREADS_LIMIT = 100

/** Preview scan depth for the thread list — see GET /messages. */
const THREAD_PREVIEW_SCAN = 300

// Per-wallet budgets. Keys are namespaced so one action can't starve
// another (declining requests must still work while a search flood is
// being throttled).
const searchLimited = createRateLimiter(60_000, 20) // 20/min
const friendRequestLimited = createRateLimiter(60_000, 20) // 20/min
const friendActionLimited = createRateLimiter(60_000, 30) // accept/decline/remove
const messageSendLimited = createRateLimiter(60_000, 30) // 30/min

/**
 * THE generic friend-request failure. Every failure mode — unknown
 * username, self-request, blocked, already friends, duplicate, DB error —
 * returns this exact response, so it can never be used to probe who exists.
 */
const FRIEND_GENERIC_ERROR = 'Could not complete that friend request'

/** Messages answer the same way for "no such user" and "not friends". */
const NOT_FRIENDS_ERROR = 'You can only message accepted friends'

/** Friendship states this file works with (`blocked` is set out-of-band). */
type FriendStatus = 'pending' | 'accepted' | 'blocked'

// ─────────────────────────────────────────────────
// REALTIME BRIDGE
// ─────────────────────────────────────────────────
/**
 * The HTTP layer must not import the socket layer (and vice-versa) — that
 * import cycle is how routes end up owning game state. Instead the socket
 * module hands us two tiny functions at boot:
 *
 *   // apps/server/src/socket/<the social presence module>.ts
 *   import { setSocialRealtime } from '../routes/social'
 *   setSocialRealtime({
 *     isOnline: (wallet) => onlineWallets.has(wallet),
 *     emitToWallet: (wallet, event, payload) =>
 *       io.to(roomForWallet(wallet)).emit(event, payload),
 *   })
 *
 * Until that call happens everything degrades safely: `online` is false for
 * everyone and live pushes are dropped (the message is still persisted, so
 * the recipient sees it on their next fetch).
 */
export interface SocialRealtime {
  /** Is this wallet currently connected on the authed "/" namespace? */
  isOnline(wallet: string): boolean
  /** Push a server→client event to every socket of one wallet. */
  emitToWallet(wallet: string, event: string, payload: unknown): void
  /**
   * Recompute + push `social:friendsOnline` to one wallet.
   *
   * Presence normally refreshes itself on a connect/disconnect flip, but the
   * friend GRAPH can change while both people stay online — accepting a
   * request or removing a friend. Without this the two sidebars keep showing
   * the pre-change ONLINE FRIENDS list until someone reconnects.
   */
  refreshFriendsOnline(wallet: string): void
}

let realtime: SocialRealtime | null = null

/** Register (or clear, with null) the socket bridge. */
export function setSocialRealtime(bridge: SocialRealtime | null): void {
  realtime = bridge
}

/** Presence lookup that can never throw into a route. */
function isOnline(wallet: string): boolean {
  try {
    return realtime?.isOnline(wallet) ?? false
  } catch (err) {
    console.error('[social] presence lookup failed:', err)
    return false
  }
}

/** Best-effort live push. A dead socket layer must not fail an HTTP write. */
function pushToWallet(wallet: string, event: string, payload: unknown): void {
  try {
    realtime?.emitToWallet(wallet, event, payload)
  } catch (err) {
    console.error(`[social] push ${event} failed:`, err)
  }
}

/**
 * Nudge BOTH sides of a friendship to re-pull their ONLINE FRIENDS list after
 * the graph changed (accept / remove). Best-effort like every other push: an
 * absent or throwing socket layer must not fail the HTTP write that just
 * succeeded.
 */
function refreshFriendsOnline(...wallets: string[]): void {
  for (const wallet of wallets) {
    try {
      realtime?.refreshFriendsOnline(wallet)
    } catch (err) {
      console.error('[social] friends-online refresh failed:', err)
    }
  }
}

// ─────────────────────────────────────────────────
// VALIDATION SCHEMAS
// ─────────────────────────────────────────────────

/** The ONLY public identifier — same regex the account registry enforces. */
const UsernameSchema = z.string().regex(USERNAME_REGEX)

/** `{ username }` — every friend endpoint's body. */
const UsernameBodySchema = z.object({ username: UsernameSchema })

/**
 * Search input. Restricted to the username charset on purpose: it keeps
 * `%`/`\` out of the LIKE pattern entirely (the `_` that IS legal in a
 * username is escaped in buildPrefixPattern), and it means a query can
 * never be a wallet fragment.
 */
const SearchQuerySchema = z
  .string()
  .trim()
  .min(SEARCH_MIN)
  .max(SEARCH_MAX)
  .regex(/^[A-Za-z0-9_]+$/)

/** Message body: 1–1000 chars AFTER trim, so whitespace-only is rejected. */
const MessageBodySchema = z.object({
  body: z.string().trim().min(1).max(1000),
})

// ─────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────

/**
 * Public shape of another person. Note what is NOT here: any wallet.
 *
 * RANKED 2.0: `rank` is the TIER only, which is all a chip needs to pick a
 * colour — but a DIVISION ("Silver III") can only be derived from the raw
 * ladder number, so `rp` rides along. It is the visible RP layer
 * (`users.rp_1v1`), never the hidden TrueSkill mu/sigma, which must never
 * leave the server: exposing it would expose matchmaking.
 */
interface PublicUser {
  username: string
  rank: RankTier
  /** Visible RP on the 1v1 ladder — the client derives tier + division. */
  rp: number
  online: boolean
}

/** Internal lookup result — `wallet` stays server-side, always. */
interface ResolvedUser {
  wallet: string
  username: string
  elo: number
}

/** The 1v1 ladder tier for a RP value (packages/types/src/elo.ts owns ranks). */
function rankOf(rp: number): RankTier {
  return getRankInfo(rp).tier
}

/**
 * username → wallet, case-insensitively (the registry's uniqueness is on
 * lower(username), so "Vanguard" and "vanguard" are the same account).
 * Returns null when no such registered account exists. THIS IS THE ONLY
 * DIRECTION CLIENTS GET: nothing ever resolves a wallet to a client.
 */
async function resolveUsername(
  db: NonNullable<ReturnType<typeof requireDb>>,
  username: string
): Promise<ResolvedUser | null> {
  const [row] = await db
    .select({ wallet: users.wallet, username: users.username, elo: users.elo })
    .from(users)
    .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
    .limit(1)

  if (!row?.username) return null
  return { wallet: row.wallet, username: row.username, elo: row.elo }
}

/**
 * "<me> accepted your friend request" → the REQUESTER's live feed.
 *
 * The accept is an HTTP call on the ACCEPTER's machine, so the requester has
 * no other way to hear about it until they refetch. Best-effort in every
 * sense: it needs my own username (an account that never finished setup has
 * none, and then there is simply nothing to announce), and a DB hiccup here
 * must never fail the accept that already committed.
 *
 * ‼️ The payload is a USERNAME — mine, which the requester already knew, since
 * they are the one who asked. No wallet, in either direction.
 */
async function notifyFriendAccepted(
  db: NonNullable<ReturnType<typeof requireDb>>,
  myWallet: string,
  requesterWallet: string
): Promise<void> {
  try {
    const [me] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.wallet, myWallet))
      .limit(1)
    if (!me?.username) return
    pushToWallet(requesterWallet, 'social:friendAccepted', {
      fromUsername: me.username,
    })
  } catch (err) {
    console.error('[social] friend-accepted push failed:', err)
  }
}

/** Matches the friends row for a pair in EITHER direction. */
function pairFilter(a: string, b: string) {
  return or(
    and(eq(friends.requesterWallet, a), eq(friends.recipientWallet, b)),
    and(eq(friends.requesterWallet, b), eq(friends.recipientWallet, a))
  )!
}

/** Every friends row between two wallets (0, 1 or — mid-race — 2 rows). */
async function relationRows(
  db: NonNullable<ReturnType<typeof requireDb>>,
  a: string,
  b: string
) {
  return db
    .select({
      id: friends.id,
      requesterWallet: friends.requesterWallet,
      status: friends.status,
    })
    .from(friends)
    .where(pairFilter(a, b))
}

/**
 * THE messaging authorization check (contract: "only between users with an
 * `accepted` friendship — check on send AND on thread fetch").
 * Fails closed: no row, a pending row, a blocked row, or a deleted
 * friendship all mean "not authorized".
 */
async function areAcceptedFriends(
  db: NonNullable<ReturnType<typeof requireDb>>,
  a: string,
  b: string
): Promise<boolean> {
  if (a === b) return false // never a friendship with yourself
  const rows = await db
    .select({ status: friends.status })
    .from(friends)
    .where(pairFilter(a, b))

  // A `blocked` row WINS over anything else, even a stale `accepted` row in
  // the opposite direction — blocking must never be defeated by ordering.
  if (rows.some((r) => r.status === 'blocked')) return false
  return rows.some((r) => r.status === 'accepted')
}

/**
 * Wallets I have a `blocked` row with, in either direction. Blocking is
 * mutual by design: a blocked pair never appears in each other's search
 * results and can never friend, message or invite one another.
 */
async function blockedWallets(
  db: NonNullable<ReturnType<typeof requireDb>>,
  wallet: string
): Promise<Set<string>> {
  const rows = await db
    .select({
      requesterWallet: friends.requesterWallet,
      recipientWallet: friends.recipientWallet,
    })
    .from(friends)
    .where(
      and(
        eq(friends.status, 'blocked'),
        or(eq(friends.requesterWallet, wallet), eq(friends.recipientWallet, wallet))
      )
    )

  const blocked = new Set<string>()
  for (const row of rows) {
    blocked.add(
      row.requesterWallet === wallet ? row.recipientWallet : row.requesterWallet
    )
  }
  return blocked
}

/**
 * Escape the LIKE metacharacters, then anchor as a prefix search.
 * `_` is legal inside a username AND is a LIKE wildcard, so without this a
 * search for `neo_x` would also match `neoax` — and, worse, a crafted query
 * could widen someone's match set. Postgres' default escape is backslash.
 */
function buildPrefixPattern(query: string): string {
  return `${query.toLowerCase().replace(/([\\%_])/g, '\\$1')}%`
}

/**
 * Keyset cursor for message paging: `createdAt|id`, never an offset, so a
 * message arriving mid-scroll can't duplicate or skip a row.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`
}

function decodeCursor(cursor?: string | null): { at: Date; id: string } | null {
  if (!cursor || typeof cursor !== 'string') return null
  const [iso, id] = cursor.split('|')
  if (!iso || !id || !UUID_RE.test(id)) return null
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : { at, id }
}

/** Clamp a `?limit=` query into a sane page size. */
function clampLimit(raw: string | undefined, fallback: number, max: number) {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, 1), max)
}

// ─────────────────────────────────────────────────
// GET /api/social/search?q=<2-20>
// → { users: [{ username, rank, elo, online }] }  (max 20)
// ─────────────────────────────────────────────────
// NO-ENUMERATION RULES, all enforced here:
//  - a query shorter than 2 chars (or outside the username charset) returns
//    an EMPTY list, not an error — a probe learns nothing either way;
//  - matching is exact-or-prefix on lower(username), never "contains", and
//    never unfiltered, so there is no way to page through the user table;
//  - at most 20 rows come back;
//  - yourself and anyone in a blocked pair are removed from the results.
social.get('/search', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)

  const wallet = c.get('wallet')

  // Validate FIRST: a too-short/illegal query does no database work, so it
  // must not burn the caller's budget — a debounced search box types its way
  // through one- and two-character states on the way to a real query.
  const parsed = SearchQuerySchema.safeParse(c.req.query('q') ?? '')
  if (!parsed.success) return c.json({ users: [] })
  const query = parsed.data
  const lowered = query.toLowerCase()

  // Only real, DB-touching searches count against the 20/min budget.
  if (searchLimited(`social:search:${wallet}`)) {
    return c.json({ error: 'Too many searches — slow down' }, 429)
  }

  try {
    const rows = await db
      .select({
        // `wallet` is selected for the block/presence checks below and is
        // deliberately dropped before the response is built.
        wallet: users.wallet,
        username: users.username,
        elo: users.elo,
        rp: users.rp1v1,
      })
      .from(users)
      .where(
        and(
          isNotNull(users.username),
          ne(users.wallet, wallet), // never surface yourself
          sql`lower(${users.username}) like ${buildPrefixPattern(query)}`
        )
      )
      // Exact match first, then prefix hits alphabetically.
      .orderBy(
        sql`case when lower(${users.username}) = ${lowered} then 0 else 1 end`,
        asc(users.username)
      )
      .limit(SEARCH_LIMIT)

    const blocked = await blockedWallets(db, wallet)

    return c.json({
      users: rows
        .filter((row) => !!row.username && !blocked.has(row.wallet))
        .map((row) => ({
          username: row.username as string,
          rank: rankOf(row.rp),
          rp: row.rp,
          // legacy mirror of `rp` — kept so a pre-Ranked-2.0 client still
          // renders a number. New code reads `rp` (see client `rankRpOf`).
          elo: row.elo,
          online: isOnline(row.wallet),
        })),
    })
  } catch (err) {
    console.error('[social] search failed:', err)
    // Same empty answer as "no matches" — failures leak nothing either.
    return c.json({ users: [] })
  }
})

// ─────────────────────────────────────────────────
// GET /api/social/friends
// → { friends: [...], incoming: [...], outgoing: [...] }
// ─────────────────────────────────────────────────
// One row shape everywhere: { username, rank, online, status }.
// `blocked` rows are excluded from all three lists — a block is not a
// relationship the UI ever renders.
social.get('/friends', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)

  const wallet = c.get('wallet')

  try {
    const rows = await db
      .select({
        requesterWallet: friends.requesterWallet,
        recipientWallet: friends.recipientWallet,
        status: friends.status,
      })
      .from(friends)
      .where(
        and(
          or(
            eq(friends.requesterWallet, wallet),
            eq(friends.recipientWallet, wallet)
          ),
          // `blocked` is fetched (not filtered out in SQL) so a block can
          // veto a coexisting pending/accepted row below.
          inArray(friends.status, ['pending', 'accepted', 'blocked'])
        )
      )

    if (rows.length === 0) {
      return c.json({ friends: [], incoming: [], outgoing: [] })
    }

    // Anyone in a blocked pair is invisible in every list, in both
    // directions — the block always wins.
    const blocked = new Set(
      rows
        .filter((r) => r.status === 'blocked')
        .map((r) =>
          r.requesterWallet === wallet ? r.recipientWallet : r.requesterWallet
        )
    )

    // wallet → username/elo for the OTHER side of each row. This is the
    // wallet→username direction, which is the only one clients ever see.
    const otherWallets = [
      ...new Set(
        rows.map((r) => (r.requesterWallet === wallet ? r.recipientWallet : r.requesterWallet))
      ),
    ]

    const profiles = await db
      .select({
        wallet: users.wallet,
        username: users.username,
        rp: users.rp1v1,
      })
      .from(users)
      .where(and(inArray(users.wallet, otherWallets), isNotNull(users.username)))

    const byWallet = new Map(profiles.map((p) => [p.wallet, p]))

    const accepted: PublicUser[] = []
    const incoming: (PublicUser & { status: FriendStatus })[] = []
    const outgoing: (PublicUser & { status: FriendStatus })[] = []

    for (const row of rows) {
      if (row.status === 'blocked') continue // never rendered
      const iAmRequester = row.requesterWallet === wallet
      const otherWallet = iAmRequester ? row.recipientWallet : row.requesterWallet
      if (blocked.has(otherWallet)) continue // block vetoes the other row
      const profile = byWallet.get(otherWallet)
      // Unregistered (no username) accounts have no public identity — they
      // simply do not appear. There is nothing safe to render for them.
      if (!profile?.username) continue

      const entry: PublicUser = {
        username: profile.username,
        rank: rankOf(profile.rp),
        rp: profile.rp,
        online: isOnline(otherWallet),
      }

      if (row.status === 'accepted') accepted.push(entry)
      else if (iAmRequester) outgoing.push({ ...entry, status: 'pending' })
      else incoming.push({ ...entry, status: 'pending' })
    }

    const byName = (a: PublicUser, b: PublicUser) =>
      a.username.localeCompare(b.username)

    return c.json({
      friends: accepted
        .sort(byName)
        .map((f) => ({ ...f, status: 'accepted' as const })),
      incoming: incoming.sort(byName),
      outgoing: outgoing.sort(byName),
    })
  } catch (err) {
    console.error('[social] friends list failed:', err)
    return c.json({ error: 'Could not load your friends' }, 500)
  }
})

// ─────────────────────────────────────────────────
// POST /api/social/friends/request { username }
// → { ok: true }   (ONE generic error on every failure)
// ─────────────────────────────────────────────────
social.post('/friends/request', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)

  const wallet = c.get('wallet')
  if (friendRequestLimited(`social:friendreq:${wallet}`)) {
    return c.json({ error: 'Too many friend requests — try again later' }, 429)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = UsernameBodySchema.safeParse(body)
  if (!parsed.success) return c.json({ error: FRIEND_GENERIC_ERROR }, 400)

  try {
    // The sender must have a public identity of their own, otherwise the
    // recipient would receive a request from nobody.
    const [me] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.wallet, wallet))
      .limit(1)
    if (!me?.username) return c.json({ error: FRIEND_GENERIC_ERROR }, 400)

    const target = await resolveUsername(db, parsed.data.username)
    // Unknown username and self-request answer identically to everything
    // else below — that sameness IS the anti-enumeration control.
    if (!target || target.wallet === wallet) {
      return c.json({ error: FRIEND_GENERIC_ERROR }, 400)
    }

    const existing = await relationRows(db, wallet, target.wallet)
    // A block (either direction) kills the request silently.
    if (existing.some((r) => r.status === 'blocked')) {
      return c.json({ error: FRIEND_GENERIC_ERROR }, 400)
    }
    // Already friends — nothing to request.
    if (existing.some((r) => r.status === 'accepted')) {
      return c.json({ error: FRIEND_GENERIC_ERROR }, 400)
    }

    const mineToThem = existing.find((r) => r.requesterWallet === wallet)
    const theirsToMe = existing.find((r) => r.requesterWallet === target.wallet)

    // They already asked me: both sides want this, so the mutual request
    // becomes the friendship. (It also prevents two mirrored `pending` rows,
    // which the per-direction unique index cannot rule out on its own.)
    if (theirsToMe?.status === 'pending') {
      await db
        .update(friends)
        .set({ status: 'accepted' })
        .where(eq(friends.id, theirsToMe.id))
      // This path ends in a real friendship, so it owes the same two pushes
      // the explicit /friends/accept route sends: refresh both ONLINE FRIENDS
      // lists (a new friendship has no presence flip of its own) and tell the
      // person who asked first that they now have a friend.
      refreshFriendsOnline(wallet, target.wallet)
      await notifyFriendAccepted(db, wallet, target.wallet)
      return c.json({ ok: true })
    }

    // Re-sending an outstanding request is a no-op, not an error: the
    // response is identical to the first send, so nothing new is revealed.
    if (mineToThem?.status === 'pending') return c.json({ ok: true })

    await db.insert(friends).values({
      requesterWallet: wallet,
      recipientWallet: target.wallet,
      status: 'pending',
    })

    // Live nudge for the recipient's sidebar badge. USERNAME ONLY.
    pushToWallet(target.wallet, 'social:friendRequest', {
      fromUsername: me.username,
    })

    return c.json({ ok: true })
  } catch (err) {
    // Includes the 23505 unique-violation race (two sends at once) — same
    // generic answer as everything else.
    console.error('[social] friend request failed:', err)
    return c.json({ error: FRIEND_GENERIC_ERROR }, 400)
  }
})

// ─────────────────────────────────────────────────
// POST /api/social/friends/accept { username }
// ─────────────────────────────────────────────────
// Only the RECIPIENT of a pending request can accept it, and only while it
// is still pending — the WHERE clause is the authorization check, so a
// crafted call can't accept a request that was never sent to you.
social.post('/friends/accept', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)

  const wallet = c.get('wallet')
  if (friendActionLimited(`social:friendact:${wallet}`)) {
    return c.json({ error: 'Too many requests — try again later' }, 429)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = UsernameBodySchema.safeParse(body)
  if (!parsed.success) return c.json({ error: FRIEND_GENERIC_ERROR }, 400)

  try {
    const target = await resolveUsername(db, parsed.data.username)
    if (!target || target.wallet === wallet) {
      return c.json({ error: FRIEND_GENERIC_ERROR }, 400)
    }

    const updated = await db
      .update(friends)
      .set({ status: 'accepted' })
      .where(
        and(
          eq(friends.requesterWallet, target.wallet),
          eq(friends.recipientWallet, wallet),
          eq(friends.status, 'pending')
        )
      )
      .returning({ id: friends.id })

    if (updated.length === 0) {
      return c.json({ error: FRIEND_GENERIC_ERROR }, 400)
    }

    // A brand-new friendship produces no connect/disconnect flip of its own,
    // so push both sidebars now — otherwise each of us stays missing from the
    // other's ONLINE FRIENDS list until a reconnect.
    refreshFriendsOnline(wallet, target.wallet)

    // Tell the REQUESTER their request went through. The accept happens on my
    // machine over HTTP, so without this they get no signal at all — their
    // notification feed would only ever show one half of a friendship forming.
    // USERNAME ONLY, and only mine, which they already knew (they asked me).
    await notifyFriendAccepted(db, wallet, target.wallet)

    return c.json({ ok: true })
  } catch (err) {
    console.error('[social] friend accept failed:', err)
    return c.json({ error: FRIEND_GENERIC_ERROR }, 400)
  }
})

// ─────────────────────────────────────────────────
// POST /api/social/friends/decline { username }
// ─────────────────────────────────────────────────
// Deletes the pending row addressed to me. Idempotent: declining something
// that isn't there still answers { ok: true }, so a probe can't use this
// endpoint to discover whether a request (or a user) exists.
social.post('/friends/decline', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)

  const wallet = c.get('wallet')
  if (friendActionLimited(`social:friendact:${wallet}`)) {
    return c.json({ error: 'Too many requests — try again later' }, 429)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = UsernameBodySchema.safeParse(body)
  if (!parsed.success) return c.json({ error: FRIEND_GENERIC_ERROR }, 400)

  try {
    const target = await resolveUsername(db, parsed.data.username)
    if (target && target.wallet !== wallet) {
      await db
        .delete(friends)
        .where(
          and(
            eq(friends.requesterWallet, target.wallet),
            eq(friends.recipientWallet, wallet),
            eq(friends.status, 'pending')
          )
        )
    }
    return c.json({ ok: true })
  } catch (err) {
    console.error('[social] friend decline failed:', err)
    return c.json({ error: FRIEND_GENERIC_ERROR }, 400)
  }
})

// ─────────────────────────────────────────────────
// POST /api/social/friends/remove { username }
// ─────────────────────────────────────────────────
// DELETES the friendship row in either direction (contract: "removing a
// friendship deletes the row so messaging authorization fails closed").
// `blocked` rows are deliberately NOT deleted — un-friending must never
// silently lift a block. Idempotent for the same reason as decline.
social.post('/friends/remove', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)

  const wallet = c.get('wallet')
  if (friendActionLimited(`social:friendact:${wallet}`)) {
    return c.json({ error: 'Too many requests — try again later' }, 429)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = UsernameBodySchema.safeParse(body)
  if (!parsed.success) return c.json({ error: FRIEND_GENERIC_ERROR }, 400)

  try {
    const target = await resolveUsername(db, parsed.data.username)
    if (target && target.wallet !== wallet) {
      await db
        .delete(friends)
        .where(
          and(
            pairFilter(wallet, target.wallet),
            inArray(friends.status, ['pending', 'accepted'])
          )
        )
      // The removed friend must disappear from both ONLINE FRIENDS lists
      // immediately — the friendship is gone, so messaging and invites now
      // fail closed and the UI must not keep offering them.
      refreshFriendsOnline(wallet, target.wallet)
    }
    return c.json({ ok: true })
  } catch (err) {
    console.error('[social] friend remove failed:', err)
    return c.json({ error: FRIEND_GENERIC_ERROR }, 400)
  }
})

// ─────────────────────────────────────────────────
// GET /api/social/messages
// → { threads: [{ username, rank, online, unread, lastAt, lastBody, lastMine }],
//     unreadTotal }
// ─────────────────────────────────────────────────
// ADDITIVE to the contract's endpoint list: the sidebar's Messages panel
// needs a conversation list and the badge needs a REAL unread count, and
// neither is derivable from the per-thread endpoint alone.
//
// Threads are intersected with CURRENT accepted friendships, so a
// conversation you can no longer open never shows up (same fail-closed rule
// as the thread read below).
social.get('/messages', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)

  const wallet = c.get('wallet')

  try {
    // Every message I am a party to, ignoring soft-deleted rows.
    const mineFilter = and(
      isNull(messages.deletedAt),
      or(eq(messages.fromWallet, wallet), eq(messages.toWallet, wallet))
    )

    // Deliberately TWO grouped queries instead of one `group by (case when
    // from_wallet = $me then to_wallet else from_wallet end)`: Postgres
    // compares the select-list expression against the GROUP BY expression
    // by parse tree, and the repeated `$me` bind lands with a different
    // param id on each side, so the clever one-query version is rejected
    // as "column must appear in the GROUP BY clause". Grouping by a plain
    // column on each side is boring and always correct.
    // `mapWith(column)` reuses the timestamp decoder → a real Date;
    // `mapWith(Number)` turns the int8 count (a string from the driver)
    // into a number.
    const sent = await db
      .select({
        partner: messages.toWallet,
        lastAt: sql`max(${messages.createdAt})`.mapWith(messages.createdAt),
      })
      .from(messages)
      .where(and(isNull(messages.deletedAt), eq(messages.fromWallet, wallet)))
      .groupBy(messages.toWallet)
      .orderBy(sql`max(${messages.createdAt}) desc`)
      .limit(THREADS_LIMIT)

    const received = await db
      .select({
        partner: messages.fromWallet,
        lastAt: sql`max(${messages.createdAt})`.mapWith(messages.createdAt),
        unread: sql<number>`count(*) filter (where ${messages.readAt} is null)`.mapWith(
          Number
        ),
      })
      .from(messages)
      .where(and(isNull(messages.deletedAt), eq(messages.toWallet, wallet)))
      .groupBy(messages.fromWallet)
      .orderBy(sql`max(${messages.createdAt}) desc`)
      .limit(THREADS_LIMIT)

    // Merge the two halves into one conversation per partner.
    const merged = new Map<string, { lastAt: Date; unread: number }>()
    for (const row of sent) {
      merged.set(row.partner, { lastAt: row.lastAt, unread: 0 })
    }
    for (const row of received) {
      const existing = merged.get(row.partner)
      if (existing) {
        if (row.lastAt > existing.lastAt) existing.lastAt = row.lastAt
        existing.unread += row.unread
      } else {
        merged.set(row.partner, { lastAt: row.lastAt, unread: row.unread })
      }
    }

    const grouped = [...merged.entries()]
      .map(([partner, v]) => ({ partner, lastAt: v.lastAt, unread: v.unread }))
      .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
      .slice(0, THREADS_LIMIT)

    if (grouped.length === 0) return c.json({ threads: [], unreadTotal: 0 })

    const partners = grouped.map((g) => g.partner)

    // Only conversations with a live accepted friendship survive — the same
    // fail-closed rule the thread read enforces, so the list can never offer
    // a conversation that would 403 on open. `blocked` rows are fetched too
    // and veto an accepted row.
    const friendRows = await db
      .select({
        requesterWallet: friends.requesterWallet,
        recipientWallet: friends.recipientWallet,
        status: friends.status,
      })
      .from(friends)
      .where(
        and(
          inArray(friends.status, ['accepted', 'blocked']),
          or(
            and(
              eq(friends.requesterWallet, wallet),
              inArray(friends.recipientWallet, partners)
            ),
            and(
              eq(friends.recipientWallet, wallet),
              inArray(friends.requesterWallet, partners)
            )
          )
        )
      )
    const allowed = new Set<string>()
    const blocked = new Set<string>()
    for (const row of friendRows) {
      const partner =
        row.requesterWallet === wallet ? row.recipientWallet : row.requesterWallet
      if (row.status === 'blocked') blocked.add(partner)
      else allowed.add(partner)
    }
    for (const wal of blocked) allowed.delete(wal)

    // wallet → username/rp (the only direction clients ever see).
    const profiles = await db
      .select({ wallet: users.wallet, username: users.username, rp: users.rp1v1 })
      .from(users)
      .where(and(inArray(users.wallet, partners), isNotNull(users.username)))
    const byWallet = new Map(profiles.map((p) => [p.wallet, p]))

    // Previews: scan the most recent N of MY messages and keep the first
    // (newest) one per partner. Cheap, index-friendly, and a thread whose
    // last message falls outside the scan simply renders without a preview.
    const recent = await db
      .select({
        fromWallet: messages.fromWallet,
        toWallet: messages.toWallet,
        body: messages.body,
      })
      .from(messages)
      .where(mineFilter)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(THREAD_PREVIEW_SCAN)

    const preview = new Map<string, { body: string; mine: boolean }>()
    for (const row of recent) {
      const partner = row.fromWallet === wallet ? row.toWallet : row.fromWallet
      if (!preview.has(partner)) {
        preview.set(partner, { body: row.body, mine: row.fromWallet === wallet })
      }
    }

    let unreadTotal = 0
    const threads = grouped
      .filter((g) => allowed.has(g.partner) && byWallet.get(g.partner)?.username)
      .map((g) => {
        const profile = byWallet.get(g.partner)!
        const last = preview.get(g.partner) ?? null
        unreadTotal += g.unread
        return {
          username: profile.username as string,
          rank: rankOf(profile.rp),
          rp: profile.rp,
          online: isOnline(g.partner),
          unread: g.unread,
          lastAt: g.lastAt,
          lastBody: last?.body ?? null,
          lastMine: last?.mine ?? false,
        }
      })

    return c.json({ threads, unreadTotal })
  } catch (err) {
    console.error('[social] thread list failed:', err)
    return c.json({ error: 'Could not load your messages' }, 500)
  }
})

// ─────────────────────────────────────────────────
// GET /api/social/messages/:username?cursor=&limit=
// → { messages: [{ id, mine, body, createdAt }], nextCursor }
// ─────────────────────────────────────────────────
// AUTHORIZATION (contract): an accepted friendship is required to READ a
// thread, not just to write one. "No such user" and "not your friend" both
// answer 403 with the same message, so the endpoint reveals nothing.
//
// Ordering: the page is fetched newest-first (keyset) and returned
// OLDEST→NEWEST, which is chat render order. `nextCursor` walks further
// BACK in time.
social.get('/messages/:username', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)

  const wallet = c.get('wallet')
  const parsed = UsernameSchema.safeParse(c.req.param('username'))
  if (!parsed.success) return c.json({ error: NOT_FRIENDS_ERROR }, 403)

  try {
    const target = await resolveUsername(db, parsed.data)
    if (!target || target.wallet === wallet) {
      return c.json({ error: NOT_FRIENDS_ERROR }, 403)
    }
    if (!(await areAcceptedFriends(db, wallet, target.wallet))) {
      return c.json({ error: NOT_FRIENDS_ERROR }, 403)
    }

    const take = clampLimit(
      c.req.query('limit'),
      MESSAGES_DEFAULT_LIMIT,
      MESSAGES_MAX_LIMIT
    )
    const after = decodeCursor(c.req.query('cursor'))

    const filters = [
      isNull(messages.deletedAt), // soft-deleted rows are never returned
      or(
        and(eq(messages.fromWallet, wallet), eq(messages.toWallet, target.wallet)),
        and(eq(messages.fromWallet, target.wallet), eq(messages.toWallet, wallet))
      )!,
    ]
    if (after) {
      filters.push(
        or(
          lt(messages.createdAt, after.at),
          and(eq(messages.createdAt, after.at), lt(messages.id, after.id))
        )!
      )
    }

    // One extra row tells us whether an older page exists, without a COUNT.
    const rows = await db
      .select({
        id: messages.id,
        fromWallet: messages.fromWallet,
        body: messages.body,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(...filters))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(take + 1)

    const page = rows.slice(0, take)
    const oldest = page[page.length - 1]

    // Opening a thread clears its unread badge. Best-effort: a failed
    // update must not fail the read.
    try {
      await db
        .update(messages)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(messages.toWallet, wallet),
            eq(messages.fromWallet, target.wallet),
            isNull(messages.readAt)
          )
        )
    } catch (err) {
      console.error('[social] mark-read failed:', err)
    }

    return c.json({
      // Chronological for rendering; `mine` replaces the sender's identity
      // so no wallet is ever serialized.
      messages: page
        .slice()
        .reverse()
        .map((row) => ({
          id: row.id,
          mine: row.fromWallet === wallet,
          body: row.body,
          createdAt: row.createdAt,
        })),
      nextCursor: rows.length > take && oldest ? encodeCursor(oldest) : null,
    })
  } catch (err) {
    console.error('[social] thread fetch failed:', err)
    return c.json({ error: 'Could not load that conversation' }, 500)
  }
})

// ─────────────────────────────────────────────────
// POST /api/social/messages/:username { body }
// → { message: { id, mine, body, createdAt } } + live push
// ─────────────────────────────────────────────────
social.post('/messages/:username', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)

  const wallet = c.get('wallet')
  if (messageSendLimited(`social:msg:${wallet}`)) {
    return c.json({ error: 'Too many messages — slow down' }, 429)
  }

  const nameParsed = UsernameSchema.safeParse(c.req.param('username'))
  if (!nameParsed.success) return c.json({ error: NOT_FRIENDS_ERROR }, 403)

  const rawBody = await c.req.json().catch(() => null)
  const bodyParsed = MessageBodySchema.safeParse(rawBody)
  if (!bodyParsed.success) {
    return c.json({ error: 'Message must be 1–1000 characters' }, 400)
  }

  try {
    const target = await resolveUsername(db, nameParsed.data)
    // Self-message and unknown user are both 403 — identical to "not
    // friends", so the endpoint stays enumeration-proof.
    if (!target || target.wallet === wallet) {
      return c.json({ error: NOT_FRIENDS_ERROR }, 403)
    }
    // THE write-side authorization check (mirrors the read side above).
    if (!(await areAcceptedFriends(db, wallet, target.wallet))) {
      return c.json({ error: NOT_FRIENDS_ERROR }, 403)
    }

    // The sender needs a public identity for the recipient to see.
    const [me] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.wallet, wallet))
      .limit(1)
    if (!me?.username) {
      return c.json({ error: 'Register a username before messaging' }, 403)
    }

    // Stored RAW (contract): escaping happens at render time in React.
    const [inserted] = await db
      .insert(messages)
      .values({
        fromWallet: wallet,
        toWallet: target.wallet,
        body: bodyParsed.data.body,
      })
      .returning({
        id: messages.id,
        body: messages.body,
        createdAt: messages.createdAt,
      })

    if (!inserted) {
      return c.json({ error: 'Could not send that message' }, 500)
    }

    // Live delivery — USERNAME ONLY, never the sender's wallet.
    pushToWallet(target.wallet, 'social:message', {
      fromUsername: me.username,
      body: inserted.body,
      createdAt: inserted.createdAt,
    })

    return c.json({
      message: {
        id: inserted.id,
        mine: true,
        body: inserted.body,
        createdAt: inserted.createdAt,
      },
    })
  } catch (err) {
    console.error('[social] message send failed:', err)
    return c.json({ error: 'Could not send that message' }, 500)
  }
})

export default social
