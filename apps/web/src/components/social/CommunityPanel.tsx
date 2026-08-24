/**
 * COMMUNITY PANEL — the public board (sidebar panel)
 * ==================================================
 * Two tabs in one panel:
 *
 *   BOARD       plain posts, newest first, with a composer on top
 *   CHALLENGES  open 1v1s: pick a game + mode, OPEN CHALLENGE hosts an OPEN
 *               private room (via the same PrivateWagerHost the nav-bar
 *               invites use) and publishes it; anyone's JOIN button feeds the
 *               room straight into that host's join path.
 *
 * HOW A CHALLENGE BECOMES A MATCH
 * -------------------------------
 *   poster:  armHost({gameKey, mode, onCreated}) → drawer closes →
 *            PrivateWagerHost navigates to the game and opens an OPEN room →
 *            onCreated(roomId) publishes the post (a plain fetch, so it
 *            outlives this panel's unmount)
 *   joiner:  armJoin({roomId, …}) → drawer closes → the host navigates and
 *            emits private:join — open rooms need no invite (server-side
 *            check in privateMatch.ts)
 *
 * ‼️ SECURITY (design contract):
 *   - USERNAMES ONLY — the feed's author field is a username; no wallet is
 *     representable on this screen.
 *   - XSS: bodies are stored RAW and rendered as TEXT (React escapes);
 *     `dangerouslySetInnerHTML` must never appear in this file.
 *   - A JOIN's roomId comes from OUR server's feed, not from user markup,
 *     and the server re-validates membership on private:join anyway.
 */

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Megaphone,
  RefreshCw,
  Send,
  Swords,
  Trash2,
} from 'lucide-react'
import { communityApi, type CommunityPost } from '../../lib/api'
import { useNotifications } from '../../notifications/NotificationsStore'
import {
  PRIVATE_WAGER_GAMES,
  type PrivateGameKey,
} from './privateWagerCatalog'
import { formatAge, readableApiError, type SocialPanelProps } from './socialContract'

/** Server limits (routes/community.ts). */
const POST_MAX = 500
const NOTE_MAX = 140

const FEED_KEY = ['community', 'feed'] as const

export interface CommunityPanelProps extends SocialPanelProps {
  /**
   * Shut the whole drawer (not just this panel). Arming a join/host mounts
   * the waiting room at z-[110], underneath the drawer's z-[200] — same
   * ordering problem the friends rows have, same fix.
   */
  closeDrawer: () => void
}

export default function CommunityPanel({ onClose, closeDrawer }: CommunityPanelProps) {
  const [tab, setTab] = useState<'board' | 'challenges'>('board')
  const { armJoin, armHost } = useNotifications()
  const queryClient = useQueryClient()

  const feed = useQuery({
    queryKey: FEED_KEY,
    queryFn: communityApi.list,
    // Challenge liveness (open/full/gone) is answered per-request by the
    // server's room registry, so a quiet refresh keeps JOIN buttons honest.
    refetchInterval: 15_000,
  })
  const posts = useMemo(
    () => (feed.data?.posts ?? []).filter((p) => p.kind === 'post'),
    [feed.data]
  )
  const challenges = useMemo(
    () => (feed.data?.posts ?? []).filter((p) => p.kind === 'challenge'),
    [feed.data]
  )

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: FEED_KEY })

  // ── board composer ───────────────────────────────────────────────────────
  const [draft, setDraft] = useState('')
  const postMutation = useMutation({
    mutationFn: (body: string) => communityApi.createPost(body),
    onSuccess: () => {
      setDraft('')
      invalidate()
    },
  })

  // ── challenge composer ───────────────────────────────────────────────────
  const [gameKey, setGameKey] = useState<PrivateGameKey>('chess')
  const game = PRIVATE_WAGER_GAMES.find((g) => g.key === gameKey)!
  const [modeId, setModeId] = useState(game.modes[0]!.id)
  const mode = game.modes.find((m) => m.id === modeId) ?? game.modes[0]!
  const [note, setNote] = useState('')

  const removeMutation = useMutation({
    mutationFn: (id: string) => communityApi.remove(id),
    onSuccess: invalidate,
  })

  /**
   * OPEN CHALLENGE. The room has to exist before the post may point at it
   * (the server verifies ownership), so publishing happens inside onCreated —
   * a plain fetch closure that survives this panel unmounting when the
   * drawer closes.
   */
  const openChallenge = () => {
    const body = note.trim()
    setNote('')
    armHost({
      gameKey,
      mode: mode.id,
      onCreated: (roomId) => {
        // Publish with retries: this runs after the drawer closed, so a
        // swallowed failure would leave the host waiting in a room advertised
        // nowhere. After the retries, tell PrivateWagerHost to say so on top
        // of the waiting room (it is the always-mounted surface).
        const attempt = (triesLeft: number) => {
          communityApi
            .createChallenge({ gameKey, mode: mode.id, roomId, body })
            .then(() => queryClient.invalidateQueries({ queryKey: FEED_KEY }))
            .catch((err) => {
              if (triesLeft > 0) {
                window.setTimeout(() => attempt(triesLeft - 1), 800)
                return
              }
              console.error('[community] challenge post failed:', err)
              window.dispatchEvent(new CustomEvent('neon:challenge-post-failed'))
            })
        }
        attempt(2)
      },
    })
    closeDrawer()
  }

  /** JOIN someone's open seat — the exact path an accepted invite takes. */
  const joinChallenge = (post: CommunityPost) => {
    if (!post.roomId || !post.gameKey || !post.mode) return
    // Only offer games the client catalog knows — an unknown key could not
    // be navigated to anyway.
    if (!PRIVATE_WAGER_GAMES.some((g) => g.key === post.gameKey)) return
    armJoin({
      roomId: post.roomId,
      gameKey: post.gameKey as PrivateGameKey,
      mode: post.mode,
      // Open rooms carry no invite TTL; the server is the authority and the
      // host consumes this immediately, so "now-ish" is all this needs.
      expiresAt: Date.now() + 60_000,
      fromUsername: post.username,
    })
    closeDrawer()
  }

  return (
    <div className="flex h-full min-h-0 flex-col font-mono text-white">
      {/* Header — same shell as every social panel */}
      <div className="flex items-center gap-2 border-b border-[#00ffd1]/20 bg-gradient-to-r from-[#00ffd1]/10 to-transparent p-4">
        <Megaphone size={16} className="shrink-0 text-[#00ffd1]" />
        <h3 className="flex-1 truncate text-sm font-black uppercase tracking-[0.2em] text-[#00ffd1]">
          Community
        </h3>
        <button
          onClick={() => void feed.refetch()}
          aria-label="Refresh"
          disabled={feed.isFetching}
          className="cursor-pointer text-white/40 transition-colors hover:text-[#00ffd1] disabled:opacity-40"
        >
          <RefreshCw size={14} className={feed.isFetching ? 'animate-spin' : ''} />
        </button>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer text-white/50 transition-colors hover:text-[#00ffd1]"
          >
            ✕
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 p-3 pb-0">
        {(
          [
            ['board', 'Board'],
            ['challenges', '1v1 Challenges'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 cursor-pointer rounded-lg px-3 py-2 text-[10px] font-bold uppercase tracking-widest transition-all ${
              tab === id
                ? 'bg-[#00ffd1] text-[#081616] shadow-[0_0_15px_rgba(0,255,209,0.4)]'
                : 'border border-white/10 text-white/50 hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'board' ? (
        <>
          {/* Composer */}
          <div className="space-y-2 p-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, POST_MAX))}
              placeholder="Say something to the arcade…"
              rows={2}
              className="w-full resize-none rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-white placeholder:text-white/25 focus:border-[#00ffd1]/50 focus:outline-none"
            />
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-white/25">
                {draft.length}/{POST_MAX}
              </span>
              <button
                onClick={() => postMutation.mutate(draft)}
                disabled={!draft.trim() || postMutation.isPending}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[#00ffd1]/15 px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[#00ffd1] transition-all hover:bg-[#00ffd1]/25 disabled:cursor-default disabled:opacity-40"
              >
                <Send size={11} /> Post
              </button>
            </div>
            {postMutation.isError && (
              <p className="text-[10px] text-red-400/80">
                {readableApiError(postMutation.error, 'Could not post')}
              </p>
            )}
          </div>

          {/* Feed */}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 pt-0">
            {feed.isPending ? (
              <Empty text="Loading…" />
            ) : feed.isError ? (
              <Empty text={readableApiError(feed.error, 'Could not load the board')} />
            ) : posts.length === 0 ? (
              <Empty text="Nothing here yet — say hi" />
            ) : (
              posts.map((post) => (
                <div
                  key={post.id}
                  className="rounded-lg border border-white/10 bg-white/5 p-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[11px] font-bold text-[#00ffd1]">
                      {post.username}
                    </span>
                    <span className="text-[9px] text-white/25">
                      {formatAge(post.createdAt)}
                    </span>
                    {post.mine && (
                      <button
                        onClick={() => removeMutation.mutate(post.id)}
                        aria-label="Delete post"
                        className="ml-auto cursor-pointer text-white/25 transition-colors hover:text-red-400"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  {/* TEXT ONLY — React escapes; pre-wrap keeps line breaks. */}
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-white/85">
                    {post.body}
                  </p>
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          {/* Challenge composer */}
          <div className="space-y-2 p-3">
            <div className="grid grid-cols-2 gap-2">
              <select
                value={gameKey}
                onChange={(e) => {
                  const key = e.target.value as PrivateGameKey
                  setGameKey(key)
                  const g = PRIVATE_WAGER_GAMES.find((entry) => entry.key === key)!
                  setModeId(g.modes[0]!.id)
                }}
                className="cursor-pointer rounded-lg border border-white/10 bg-[#0d201d] p-2 text-[10px] uppercase tracking-widest text-white focus:border-[#00ffd1]/50 focus:outline-none"
              >
                {PRIVATE_WAGER_GAMES.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.title}
                  </option>
                ))}
              </select>
              <select
                value={mode.id}
                onChange={(e) => setModeId(e.target.value)}
                className="cursor-pointer rounded-lg border border-white/10 bg-[#0d201d] p-2 text-[10px] uppercase tracking-widest text-white focus:border-[#00ffd1]/50 focus:outline-none"
              >
                {game.modes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
              placeholder="Optional trash talk…"
              className="w-full rounded-lg border border-white/10 bg-white/5 p-2.5 text-xs text-white placeholder:text-white/25 focus:border-[#00ffd1]/50 focus:outline-none"
            />
            <button
              onClick={openChallenge}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-[#00ffd1] px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-[#081616] shadow-[0_0_20px_rgba(0,255,209,0.3)] transition-all hover:shadow-[0_0_30px_rgba(0,255,209,0.5)]"
            >
              <Swords size={12} /> Open Challenge
            </button>
            <p className="text-[9px] leading-relaxed text-white/30">
              Opens a waiting room and posts it here — the first player to hit
              JOIN takes the seat.
            </p>
          </div>

          {/* Challenge feed */}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 pt-0">
            {feed.isPending ? (
              <Empty text="Loading…" />
            ) : feed.isError ? (
              <Empty text={readableApiError(feed.error, 'Could not load challenges')} />
            ) : challenges.length === 0 ? (
              <Empty text="No open challenges — post one" />
            ) : (
              challenges.map((post) => (
                <ChallengeRow
                  key={post.id}
                  post={post}
                  onJoin={() => joinChallenge(post)}
                  onDelete={() => removeMutation.mutate(post.id)}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ChallengeRow({
  post,
  onJoin,
  onDelete,
}: {
  post: CommunityPost
  onJoin: () => void
  onDelete: () => void
}) {
  const game = PRIVATE_WAGER_GAMES.find((g) => g.key === post.gameKey)
  const modeLabel =
    game?.modes.find((m) => m.id === post.mode)?.label ?? post.mode ?? ''
  const joinable = post.state === 'open' && !post.mine && game !== undefined

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-[11px] font-bold text-[#00ffd1]">
          {post.username}
        </span>
        <span className="text-[9px] text-white/25">{formatAge(post.createdAt)}</span>
        {post.mine && (
          <button
            onClick={onDelete}
            aria-label="Delete challenge"
            className="ml-auto cursor-pointer text-white/25 transition-colors hover:text-red-400"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      <div className="mt-1.5 text-xs font-bold uppercase tracking-wider text-white/85">
        {game?.title ?? post.gameKey} · {modeLabel}
      </div>
      {post.body && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-white/60">
          {post.body}
        </p>
      )}
      <div className="mt-2">
        {joinable ? (
          <button
            onClick={onJoin}
            className="w-full cursor-pointer rounded-lg bg-[#00ffd1]/15 py-2 text-[10px] font-bold uppercase tracking-widest text-[#00ffd1] transition-all hover:bg-[#00ffd1]/25"
          >
            Join 1v1
          </button>
        ) : (
          <span className="block w-full rounded-lg border border-white/10 py-2 text-center text-[10px] font-bold uppercase tracking-widest text-white/30">
            {post.mine
              ? post.state === 'open'
                ? 'Your challenge — waiting'
                : 'Your challenge'
              : post.state === 'full'
                ? // 'full' only means the seat is taken — the joiner may not
                  // have readied up yet, so never claim a match is running.
                  'Seat taken'
                : 'Expired'}
          </span>
        )}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="py-10 text-center text-[10px] uppercase tracking-[0.2em] text-white/30">
      {text}
    </div>
  )
}
