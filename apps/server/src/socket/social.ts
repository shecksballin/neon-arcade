/**
 * SOCIAL PRESENCE + LIVE PUSH — registerSocial(io, socket)
 * ========================================================
 * The realtime half of the social features. Three jobs, nothing else:
 *
 *   1. PRESENCE — remember which AUTHED wallets currently hold a "/" socket
 *      and push `social:friendsOnline { usernames }` to a user on connect and
 *      whenever one of their friends' presence flips (first tab in / last tab
 *      out). This is what drives the sidebar's ONLINE FRIENDS list.
 *   2. LIVE PUSH — `pushToWallet(wallet, event, payload)` so the HTTP routes
 *      (routes/social.ts) can deliver `social:message` / `social:friendRequest`
 *      to a recipient that is online right now.
 *   3. Shared lookups every social surface needs: `areFriends`,
 *      `resolveUsernameToWallet`, `acceptedFriendWallets`.
 *
 * ‼️ SECURITY (the single most important rule of this feature set)
 * ---------------------------------------------------------------
 * A WALLET IS PRIVATE and must NEVER reach another user. Wallets are the
 * INTERNAL key here — the map keys, the DB columns, the push target — but the
 * only thing that ever goes out on the wire is a `username`. Identity is
 * ALWAYS `socket.data.wallet` from the verified handshake JWT (socket/auth.ts);
 * a payload never names its own actor.
 *
 * WIRE CONTRACT
 * -------------
 *   C→S  social:presence                      — no payload; re-send my list
 *   S→C  social:friendsOnline { usernames[] }  — accepted friends online NOW
 *   S→C  social:message { fromUsername, body, createdAt }   (pushed by HTTP)
 *   S→C  social:friendRequest { fromUsername }              (pushed by HTTP)
 *
 * Everything here is best-effort and DB-optional: with no DATABASE_URL there
 * are no friendships to resolve, so the online list is simply empty. Nothing
 * in this file may ever throw into a socket handler.
 */

import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import { and, eq, or, sql } from 'drizzle-orm'
import { db } from '../db'
import { friends, users } from '../db/schema'
import { createRateLimiter } from '../lib/rateLimit'

// ---------------------------------------------------------------------------
// Wire constants — exported so routes/social.ts and the private-wager module
// can't drift on an event name.
// ---------------------------------------------------------------------------

export const FRIENDS_ONLINE_EVENT = 'social:friendsOnline'
export const MESSAGE_EVENT = 'social:message'
export const FRIEND_REQUEST_EVENT = 'social:friendRequest'

/** The ONE username shape used by every social surface (design contract). */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/

/** Reusable zod for a username payload field. */
export const usernameSchema = z.string().regex(USERNAME_PATTERN)

/** Safety valve on the presence fan-out — a user with more accepted friends
 *  than this simply gets the first N (nobody has 500 friends; a hostile row
 *  spammer must not be able to turn one connect into unbounded work). */
const MAX_FRIENDS_SCAN = 500

/** `social:presence` is a client-triggered refresh — throttle it per wallet. */
const presenceLimiter = createRateLimiter(60_000, 30)

/**
 * Payload-less events still get validated: undefined / null / {} are accepted
 * and anything else is ignored (same convention as socket/freeplay/types.ts).
 */
const noPayloadSchema = z.union([z.undefined(), z.null(), z.object({}).strip()])

// ---------------------------------------------------------------------------
// Online registry — in-memory, per process (same convention as presence.ts)
// ---------------------------------------------------------------------------

/**
 * wallet → (socket.id → Socket). A wallet is ONLINE while it holds at least
 * one live socket, so multiple tabs never make a user flicker offline.
 * Wallets never leave this module.
 */
const online = new Map<string, Map<string, Socket>>()

/** Register a connection. Returns true when it is the wallet's FIRST socket
 *  (i.e. the user just came online — a presence flip worth announcing). */
function trackConnection(wallet: string, socket: Socket): boolean {
  let sockets = online.get(wallet)
  if (!sockets) {
    sockets = new Map()
    online.set(wallet, sockets)
  }
  const wasOffline = sockets.size === 0
  sockets.set(socket.id, socket)
  return wasOffline
}

/** Drop a connection. Returns true when it was the wallet's LAST socket. */
function untrackConnection(wallet: string, socket: Socket): boolean {
  const sockets = online.get(wallet)
  if (!sockets) return false
  sockets.delete(socket.id)
  if (sockets.size > 0) return false
  online.delete(wallet)
  return true
}

/** Every live socket of a wallet (empty when offline). */
export function socketsForWallet(wallet: string): Socket[] {
  return [...(online.get(wallet)?.values() ?? [])]
}

/** Is this wallet holding at least one authed socket right now? */
export function isWalletOnline(wallet: string): boolean {
  return (online.get(wallet)?.size ?? 0) > 0
}

/** The registered username of an ONLINE wallet (from its handshake), or null
 *  when the wallet is offline or has no account yet. */
export function onlineUsernameOf(wallet: string): string | null {
  for (const socket of online.get(wallet)?.values() ?? []) {
    const name = socket.data.username as string | null | undefined
    if (name) return name
  }
  return null
}

// ---------------------------------------------------------------------------
// Live push — THE helper the HTTP routes call
// ---------------------------------------------------------------------------

/**
 * Deliver `event` to every live socket of `wallet`. Returns how many sockets
 * were reached (0 = the user is offline; the caller should still have
 * persisted whatever it is pushing — sockets are a courtesy, not storage).
 *
 * The wallet is the ADDRESS, never part of the payload: callers must build
 * username-only payloads (see pushMessage / pushFriendRequest below).
 */
export function pushToWallet(
  wallet: string,
  event: string,
  payload: unknown
): number {
  const sockets = online.get(wallet)
  if (!sockets || sockets.size === 0) return 0
  let delivered = 0
  for (const socket of sockets.values()) {
    try {
      socket.emit(event, payload)
      delivered++
    } catch (err) {
      // A dead socket must never break a push loop.
      console.error('[social] push failed:', err)
    }
  }
  return delivered
}

/** Typed sugar for `social:message` — usernames only, never wallets. */
export function pushMessage(
  toWallet: string,
  message: { fromUsername: string; body: string; createdAt: string | Date }
): number {
  return pushToWallet(toWallet, MESSAGE_EVENT, {
    fromUsername: message.fromUsername,
    body: message.body,
    createdAt:
      message.createdAt instanceof Date
        ? message.createdAt.toISOString()
        : message.createdAt,
  })
}

/** Typed sugar for `social:friendRequest` — usernames only. */
export function pushFriendRequest(
  toWallet: string,
  fromUsername: string
): number {
  return pushToWallet(toWallet, FRIEND_REQUEST_EVENT, { fromUsername })
}

// ---------------------------------------------------------------------------
// Shared lookups (drizzle only; null-safe when there is no database)
// ---------------------------------------------------------------------------

/**
 * Username → wallet, resolved case-insensitively on `lower(username)` (the
 * same functional index that enforces uniqueness). The result stays SERVER
 * SIDE: it is what lets us address a friend without ever telling a client
 * their wallet. Returns the canonically-cased username alongside it.
 */
export async function resolveUsernameToWallet(
  username: string
): Promise<{ wallet: string; username: string } | null> {
  if (!db) return null
  if (!USERNAME_PATTERN.test(username)) return null
  try {
    const [row] = await db
      .select({ wallet: users.wallet, username: users.username })
      .from(users)
      .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
      .limit(1)
    if (!row?.username) return null
    return { wallet: row.wallet, username: row.username }
  } catch (err) {
    console.error('[social] username lookup failed:', err)
    return null
  }
}

/**
 * THE friendship test: a friendship exists when a row (a,b) OR (b,a) has
 * status 'accepted'. Fails CLOSED — no database, a DB error or the same
 * wallet twice all return false, so authorization can never be granted by
 * accident.
 */
export async function areFriends(
  walletA: string,
  walletB: string
): Promise<boolean> {
  if (!db) return false
  if (!walletA || !walletB || walletA === walletB) return false
  try {
    const [row] = await db
      .select({ id: friends.id })
      .from(friends)
      .where(
        and(
          eq(friends.status, 'accepted'),
          or(
            and(
              eq(friends.requesterWallet, walletA),
              eq(friends.recipientWallet, walletB)
            ),
            and(
              eq(friends.requesterWallet, walletB),
              eq(friends.recipientWallet, walletA)
            )
          )
        )
      )
      .limit(1)
    return row !== undefined
  } catch (err) {
    console.error('[social] friendship check failed:', err)
    return false
  }
}

/** Every wallet with an ACCEPTED friendship to `wallet` (either direction). */
export async function acceptedFriendWallets(wallet: string): Promise<string[]> {
  if (!db || !wallet) return []
  try {
    const rows = await db
      .select({
        requester: friends.requesterWallet,
        recipient: friends.recipientWallet,
      })
      .from(friends)
      .where(
        and(
          eq(friends.status, 'accepted'),
          or(
            eq(friends.requesterWallet, wallet),
            eq(friends.recipientWallet, wallet)
          )
        )
      )
      .limit(MAX_FRIENDS_SCAN)
    return rows.map((row) =>
      row.requester === wallet ? row.recipient : row.requester
    )
  } catch (err) {
    console.error('[social] friend list lookup failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Presence fan-out
// ---------------------------------------------------------------------------

/**
 * Recompute "which of my friends are online" and push it to `wallet`.
 * Usernames only — the wallets we intersect against never leave this module.
 * Exported so routes/social.ts can refresh both sides right after a friend
 * request is accepted (a brand-new friendship has no presence flip of its own).
 */
export async function pushFriendsOnlineTo(wallet: string): Promise<void> {
  if (!isWalletOnline(wallet)) return
  const usernames: string[] = []
  for (const friendWallet of await acceptedFriendWallets(wallet)) {
    // Offline friends, and friends who never finished account setup (no
    // username), are simply absent from the list.
    const name = onlineUsernameOf(friendWallet)
    if (name) usernames.push(name)
  }
  usernames.sort((a, b) => a.localeCompare(b))
  pushToWallet(wallet, FRIENDS_ONLINE_EVENT, { usernames })
}

/**
 * `wallet` just came online or went offline: refresh the ONLINE FRIENDS list
 * of every friend who is online to see it. Sequential on purpose — this runs
 * off a connect/disconnect, and a friend list is small.
 */
async function announcePresenceFlip(wallet: string): Promise<void> {
  for (const friendWallet of await acceptedFriendWallets(wallet)) {
    if (!isWalletOnline(friendWallet)) continue
    await pushFriendsOnlineTo(friendWallet)
  }
}

// ---------------------------------------------------------------------------
// registerSocial — per-connection wiring (called from socket/index.ts)
// ---------------------------------------------------------------------------

export function registerSocial(_io: Server, socket: Socket): void {
  // Identity comes ONLY from the verified handshake. socketAuth guarantees it,
  // but a missing wallet must never crash the connection.
  const wallet = socket.data.wallet as string | undefined
  if (!wallet) return

  const isFirstSocket = trackConnection(wallet, socket)

  // This tab gets its list immediately (even when it is the wallet's second
  // tab — the new tab knows nothing yet)…
  void pushFriendsOnlineTo(wallet).catch((err) =>
    console.error('[social] initial presence push failed:', err)
  )
  // …and the user's friends only hear about a real flip offline → online.
  if (isFirstSocket) {
    void announcePresenceFlip(wallet).catch((err) =>
      console.error('[social] presence announce failed:', err)
    )
  }

  // ------------------------------------------------------- social:presence
  // Client-triggered refresh (sidebar mount / tab focus). No payload, rate
  // limited per wallet so it can't be used to hammer the database.
  socket.on('social:presence', (payload: unknown) => {
    if (!noPayloadSchema.safeParse(payload).success) return
    if (presenceLimiter(wallet)) return
    void pushFriendsOnlineTo(wallet).catch((err) =>
      console.error('[social] presence refresh failed:', err)
    )
  })

  // ------------------------------------------------------------ disconnect
  // Per-module cleanup (design contract: no central disconnect loop).
  socket.on('disconnect', () => {
    const wasLastSocket = untrackConnection(wallet, socket)
    if (!wasLastSocket) return // another tab keeps the user online
    void announcePresenceFlip(wallet).catch((err) =>
      console.error('[social] presence announce failed:', err)
    )
  })
}
