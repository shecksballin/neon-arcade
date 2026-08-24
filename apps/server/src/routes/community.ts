/**
 * COMMUNITY ROUTES (Hono) — the public board
 * ==========================================
 * Two kinds of row share one feed:
 *   'post'      — plain text for everyone signed in to read
 *   'challenge' — "come 1v1 me": carries { gameKey, mode, roomId } where
 *                 roomId is an OPEN private room the AUTHOR is hosting
 *                 (see privateMatch.ts createSchema.open). The client's JOIN
 *                 button feeds that roomId into the same PrivateWagerHost
 *                 path a friend invite takes.
 *
 * ‼️ SECURITY MODEL — same rules as routes/social.ts
 * --------------------------------------------------
 *   - the caller is ALWAYS `c.get('wallet')` (verified JWT via requireAuth);
 *     no endpoint accepts a wallet as input, and none ever returns one —
 *     authors go out as `username`, resolved at read time;
 *   - zod on every body; post bodies are stored RAW and escaped by React at
 *     render time (never dangerouslySetInnerHTML on the client);
 *   - a challenge may only advertise a room the CALLER is hosting and that
 *     is genuinely open (ownsOpenRoom) — otherwise anyone could point the
 *     community at someone else's room, or at a room that never existed;
 *   - room liveness is answered by the in-memory registry at read time
 *     (challengeRoomState), never persisted — rooms die with the process and
 *     stored state would only ever be stale;
 *   - soft delete only, same as messages.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { requireDb } from '../db'
import { communityPosts, users } from '../db/schema'
import { requireAuth, type AuthVariables } from '../middleware/requireAuth'
import { createRateLimiter } from '../lib/rateLimit'
import {
  challengeRoomState,
  ownsOpenRoom,
  privateWagerModes,
} from '../socket/games/privateMatch'

const community = new Hono<{ Variables: AuthVariables }>()

// The board is for signed-in players — no anonymous reads or writes.
community.use('*', requireAuth)

// ─────────────────────────────────────────────────
// CONSTANTS + RATE LIMITS
// ─────────────────────────────────────────────────

/** One page of feed. No cursor yet — the board shows the latest slice. */
const FEED_LIMIT = 50

const POST_BODY_MAX = 500
const CHALLENGE_NOTE_MAX = 140

// Per-wallet budgets, namespaced like social.ts so one action can't starve
// another.
const postLimited = createRateLimiter(60_000, 6) // 6 board posts/min
// Challenges get their OWN budget: a chatty user must never have their
// challenge-publish 429'd by their board posts — that failure happens after
// the waiting room is already open, which would strand the host in a room
// advertised nowhere.
const challengeLimited = createRateLimiter(60_000, 4)
const deleteLimited = createRateLimiter(60_000, 20)

// ─────────────────────────────────────────────────
// SCHEMAS
// ─────────────────────────────────────────────────

const createPostSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('post'),
    body: z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(POST_BODY_MAX)),
  }),
  z.object({
    kind: z.literal('challenge'),
    // The note is optional flavour ("bring your best opening") — empty is fine.
    body: z.string().transform((s) => s.trim()).pipe(z.string().max(CHALLENGE_NOTE_MAX)),
    gameKey: z.string().min(1).max(24),
    mode: z.string().min(1).max(24),
    roomId: z.string().uuid(),
  }),
])

const idParamSchema = z.string().uuid()

// ─────────────────────────────────────────────────
// GET / — the feed, newest first
// ─────────────────────────────────────────────────

community.get('/', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)
  const wallet = c.get('wallet')

  // ONE WINDOW PER KIND — a shared newest-50 window let ordinary board
  // chatter push every live challenge out of the feed while its host sat in
  // an open room advertised nowhere.
  const select = () =>
    db
      .select({
        id: communityPosts.id,
        authorWallet: communityPosts.authorWallet,
        kind: communityPosts.kind,
        body: communityPosts.body,
        gameKey: communityPosts.gameKey,
        mode: communityPosts.mode,
        roomId: communityPosts.roomId,
        createdAt: communityPosts.createdAt,
      })
      .from(communityPosts)
  const [boardRows, challengeRows] = await Promise.all([
    select()
      .where(and(isNull(communityPosts.deletedAt), eq(communityPosts.kind, 'post')))
      .orderBy(desc(communityPosts.createdAt))
      .limit(FEED_LIMIT),
    select()
      .where(and(isNull(communityPosts.deletedAt), eq(communityPosts.kind, 'challenge')))
      .orderBy(desc(communityPosts.createdAt))
      .limit(FEED_LIMIT),
  ])
  const rows = [...challengeRows, ...boardRows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )

  // Resolve authors to usernames in ONE query. A wallet with no username row
  // any more (account rebuild) renders as the generic "player".
  const walletSet = [...new Set(rows.map((r) => r.authorWallet))]
  const names = walletSet.length
    ? await db
        .select({ wallet: users.wallet, username: users.username })
        .from(users)
        .where(inArray(users.wallet, walletSet))
    : []
  const nameOf = new Map(names.map((n) => [n.wallet, n.username]))

  return c.json({
    posts: rows.map((r) => ({
      id: r.id,
      username: nameOf.get(r.authorWallet) ?? 'player',
      kind: r.kind,
      body: r.body,
      gameKey: r.gameKey,
      mode: r.mode,
      roomId: r.roomId,
      // Live seat state for challenges; posts have no room to ask about.
      state: r.kind === 'challenge' && r.roomId ? challengeRoomState(r.roomId) : null,
      createdAt: r.createdAt,
      mine: r.authorWallet === wallet,
    })),
  })
})

// ─────────────────────────────────────────────────
// POST / — write a post or advertise a challenge
// ─────────────────────────────────────────────────

community.post('/', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)
  const wallet = c.get('wallet')

  const parsed = createPostSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Invalid post' }, 400)
  }
  const input = parsed.data

  const limiter = input.kind === 'challenge' ? challengeLimited : postLimited
  if (limiter(`community:${input.kind}:${wallet}`)) {
    return c.json({ error: 'Slow down a moment' }, 429)
  }

  if (input.kind === 'challenge') {
    // The pair must be something a private room can actually host…
    const supported = privateWagerModes().some(
      (m) => m.gameKey === input.gameKey && m.mode === input.mode
    )
    if (!supported) {
      return c.json({ error: 'That game mode has no private match' }, 400)
    }
    // …and the room must be a live OPEN room hosted by the caller FOR THIS
    // game/mode — the pin stops a post advertising a different game than the
    // room actually hosts (see ownsOpenRoom).
    if (!ownsOpenRoom(input.roomId, wallet, input.gameKey, input.mode)) {
      return c.json({ error: 'Open a challenge room first' }, 400)
    }
  }

  const [row] = await db
    .insert(communityPosts)
    .values({
      authorWallet: wallet,
      kind: input.kind,
      body: input.body,
      gameKey: input.kind === 'challenge' ? input.gameKey : null,
      mode: input.kind === 'challenge' ? input.mode : null,
      roomId: input.kind === 'challenge' ? input.roomId : null,
    })
    .returning({ id: communityPosts.id })

  return c.json({ ok: true, id: row!.id })
})

// ─────────────────────────────────────────────────
// DELETE /:id — retire your own row (soft)
// ─────────────────────────────────────────────────

community.delete('/:id', async (c) => {
  const db = requireDb()
  if (!db) return c.json({ error: 'Database is not configured on this server' }, 503)
  const wallet = c.get('wallet')
  if (deleteLimited(`community:delete:${wallet}`)) {
    return c.json({ error: 'Slow down a moment' }, 429)
  }
  const id = idParamSchema.safeParse(c.req.param('id'))
  if (!id.success) return c.json({ error: 'Invalid post' }, 400)

  // Author-only, and answered identically whether the row is missing, someone
  // else's, or already deleted — nothing to enumerate.
  await db
    .update(communityPosts)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(communityPosts.id, id.data),
        eq(communityPosts.authorWallet, wallet),
        isNull(communityPosts.deletedAt)
      )
    )
  return c.json({ ok: true })
})

export default community
