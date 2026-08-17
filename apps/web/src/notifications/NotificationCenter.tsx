/**
 * NAV-BAR NOTIFICATION CENTRE — the bell and everything behind it
 * ==============================================================
 * This owns the bell button AND its dropdown, so App.tsx only has to place it
 * in the nav pill. Five sections, in the order you would act on them:
 *
 *   INVITES    live private-wager invites (store) → JOIN opens the waiting
 *              room in join mode, exactly like accepting from a pop-up
 *   REQUESTS   incoming friend requests (GET /api/social/friends) → accept /
 *              decline inline, plus "X accepted your request" from the store
 *   MESSAGES   unread conversations (GET /api/social/messages) → opens that
 *              thread in the sidebar's Messages panel
 *   DAILY      the daily Neon Bucks reward (unchanged, local)
 *   FOOTER     "All messages" / "Friends" — the two sidebar panels
 *
 * WHY BOTH A STORE AND TWO QUERIES
 * --------------------------------
 * The store holds what arrived on the socket THIS session. The two queries
 * hold what the server already knows — so a reload, or a message that landed
 * while the tab was closed, still shows up. Invites are socket-only by nature
 * (a room is in-memory server state), which is why the server replays live
 * invites on connect; see `registerPrivateMatch`.
 *
 * ‼️ SECURITY: usernames only, rendered as text.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell,
  Check,
  Gift,
  MessageSquare,
  Sparkles,
  Swords,
  UserPlus,
  UserRoundCheck,
  X,
} from 'lucide-react'
import { socialApi } from '../lib/api'
import type { FriendEntry, MessageThread } from '../lib/api'
import { SOCIAL_KEYS, formatAge } from '../components/social/socialContract'
import { SOCIAL_EVENTS, useSocialEvent } from '../components/social/usePresence'
import { useNotifications } from './NotificationsStore'
import type { NotificationItem } from './types'

export interface NotificationCenterProps {
  /** A finished account — everything server-backed is gated on it. */
  signedIn: boolean
  /** Daily reward, owned by App (localStorage + Neon Bucks). */
  dailyAvailable: boolean
  onClaimDaily: () => void
  /** Practice balance, shown in the header exactly as it always was. */
  balance: number
  /** Open the sidebar's Messages panel (optionally on one conversation). */
  onOpenMessages: (username?: string) => void
  /** Open the sidebar's Friends panel. */
  onOpenFriends: () => void
}

export function NotificationCenter({
  signedIn,
  dailyAvailable,
  onClaimDaily,
  balance,
  onOpenMessages,
  onOpenFriends,
}: NotificationCenterProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()
  const {
    invites: allInvites,
    items,
    unread: unreadFeed,
    acceptInvite,
    declineInvite,
    markAllRead,
    dismiss,
  } = useNotifications()
  // Signed out, nothing personal is shown — the store is cleared when the
  // socket bridge unmounts, but this is not conditional on that ordering.
  const invites = signedIn ? allInvites : []
  const unread = signedIn ? unreadFeed : 0

  // ── close on outside click / Escape ─────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Opening the panel IS reading it — the badge should not survive a look.
  useEffect(() => {
    if (open) markAllRead()
  }, [open, markAllRead])

  // ── server-backed counts ────────────────────────────────────────────────
  // Shared cache keys with the sidebar panels (SOCIAL_KEYS), so accepting a
  // request here updates the drawer's badge and vice-versa.
  const friendsQuery = useQuery({
    queryKey: SOCIAL_KEYS.friends,
    queryFn: socialApi.friends,
    enabled: signedIn,
    staleTime: 60_000,
  })

  const threadsQuery = useQuery({
    queryKey: SOCIAL_KEYS.threads,
    queryFn: socialApi.threads,
    enabled: signedIn,
    staleTime: 60_000,
  })

  // Live pushes move the counts without waiting for a refetch window.
  useSocialEvent(
    SOCIAL_EVENTS.friendRequest,
    () => void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.friends }),
    signedIn
  )
  useSocialEvent(
    SOCIAL_EVENTS.friendAccepted,
    () => void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.friends }),
    signedIn
  )
  useSocialEvent(
    SOCIAL_EVENTS.message,
    () => void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.threads }),
    signedIn
  )

  /**
   * ‼️ EVERY server-backed read below is gated on `signedIn`, not just the
   * fetch. `enabled: false` stops react-query REFETCHING; it does not evict,
   * and the QueryClient is a module-level singleton. Reading the cache
   * unguarded would keep the previous account's incoming friend requests and
   * unread DM previews on screen after a sign-out — on a shared machine, in a
   * bell that is rendered signed out too. (App.tsx also clears the cache on
   * disconnect; this is the half that does not depend on which sign-out path
   * was taken.)
   */
  const incoming = signedIn ? friendsQuery.data?.incoming ?? [] : []
  const unreadThreads = useMemo(
    () =>
      signedIn
        ? (threadsQuery.data?.threads ?? []).filter((thread) => thread.unread > 0)
        : [],
    [threadsQuery.data, signedIn]
  )
  const unreadTotal = signedIn ? threadsQuery.data?.unreadTotal ?? 0 : 0

  /** "X accepted your request" — the only feed rows with no server mirror. */
  const accepted = useMemo(
    () =>
      signedIn ? items.filter((item) => item.kind === 'friend_accepted') : [],
    [items, signedIn]
  )

  // ── friend request actions ──────────────────────────────────────────────
  const respond = useMutation({
    mutationFn: ({ kind, username }: { kind: 'accept' | 'decline'; username: string }) =>
      kind === 'accept'
        ? socialApi.acceptFriend(username)
        : socialApi.declineFriend(username),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.friends })
      void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.threads })
    },
  })
  const busyWith = respond.isPending ? respond.variables?.username ?? null : null

  // ── the badge ───────────────────────────────────────────────────────────
  // Actionable things, not "unseen" things: an invite you have already looked
  // at is still an invite waiting on you.
  const actionable =
    invites.length + incoming.length + unreadTotal + (dailyAvailable ? 1 : 0)
  const showDot = actionable > 0 || unread > 0

  const goMessages = (username?: string) => {
    setOpen(false)
    onOpenMessages(username)
  }
  const goFriends = () => {
    setOpen(false)
    onOpenFriends()
  }

  return (
    <div className="relative z-30" ref={rootRef}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="group pointer-events-auto relative flex cursor-pointer items-center justify-center rounded-full border border-white/10 p-2.5 transition-all hover:border-[#00FFD1]/50 hover:bg-[#00FFD1]/10"
        title="Notifications"
        aria-label={
          actionable > 0 ? `Notifications, ${actionable} waiting` : 'Notifications'
        }
        aria-expanded={open}
      >
        <Bell className="h-4 w-4 text-white transition-colors group-hover:text-[#00FFD1]" />
        {showDot && (
          <>
            <span className="absolute right-0.5 top-0.5 h-2 w-2 animate-ping rounded-full bg-rose-500 shadow-[0_0_10px_#f43f5e]" />
            <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-rose-500 shadow-[0_0_8px_#f43f5e]" />
          </>
        )}
        {actionable > 1 && (
          <span className="absolute -bottom-1 -right-1 min-w-[16px] rounded-full bg-[#00FFD1] px-1 text-[8px] font-black leading-4 text-[#081616]">
            {actionable > 9 ? '9+' : actionable}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            /* max-w caps the 328px panel to the viewport minus the nav's own
               margins, so it can't hang off the left edge on a 390px phone.
               max-h + scroll keeps a busy feed inside the screen. */
            className="w-82 absolute right-0 z-[100] mt-3 max-h-[min(70vh,32rem)] max-w-[calc(100vw-2.5rem)] space-y-4 overflow-y-auto rounded-2xl border border-[#00FFD1]/40 bg-[#081616]/98 p-4 text-left font-mono shadow-[0_0_50px_rgba(0,255,209,0.15)] backdrop-blur-xl"
          >
            <div className="flex items-center justify-between border-b border-[#00FFD1]/20 pb-2">
              <span className="flex animate-pulse items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-[#00FFD1]">
                <Sparkles className="h-3.5 w-3.5" /> System Feeds
              </span>
              <span className="flex items-center gap-0 text-[8px] uppercase text-white/30">
                Wallet:{' '}
                <img
                  src="/neon-bucks-icon.png"
                  alt="NB"
                  referrerPolicy="no-referrer"
                  className="-mr-0.5 inline-block h-4 w-auto drop-shadow-[0_0_5px_rgba(0,255,209,0.5)]"
                />{' '}
                {balance}
              </span>
            </div>

            {/* ── INVITES ─────────────────────────────────────────────── */}
            {invites.length > 0 && (
              <Section title={`Wager invites (${invites.length})`}>
                {invites.map((invite) => (
                  <InviteRow
                    key={invite.id}
                    item={invite}
                    onJoin={() => {
                      setOpen(false)
                      acceptInvite(invite.invite!.roomId)
                    }}
                    onDecline={() => declineInvite(invite.invite!.roomId)}
                  />
                ))}
              </Section>
            )}

            {/* ── FRIEND REQUESTS + ACCEPTS ───────────────────────────── */}
            {(incoming.length > 0 || accepted.length > 0) && (
              <Section
                title={
                  incoming.length > 0
                    ? `Friend requests (${incoming.length})`
                    : 'Friends'
                }
              >
                {incoming.map((entry: FriendEntry) => (
                  <FeedRow
                    key={`req-${entry.username}`}
                    icon={<UserPlus className="h-4 w-4" />}
                    title={entry.username}
                    subtitle="wants to be friends"
                    onClick={goFriends}
                    actions={
                      <>
                        <MiniButton
                          label={`Accept ${entry.username}`}
                          disabled={busyWith === entry.username}
                          onClick={() =>
                            respond.mutate({ kind: 'accept', username: entry.username })
                          }
                        >
                          <Check className="h-3.5 w-3.5" />
                        </MiniButton>
                        <MiniButton
                          label={`Decline ${entry.username}`}
                          tone="danger"
                          disabled={busyWith === entry.username}
                          onClick={() =>
                            respond.mutate({ kind: 'decline', username: entry.username })
                          }
                        >
                          <X className="h-3.5 w-3.5" />
                        </MiniButton>
                      </>
                    }
                  />
                ))}
                {accepted.map((item) => (
                  <FeedRow
                    key={item.id}
                    icon={<UserRoundCheck className="h-4 w-4" />}
                    title={item.from}
                    subtitle={item.body}
                    onClick={goFriends}
                    actions={
                      <MiniButton
                        label="Dismiss"
                        tone="quiet"
                        onClick={() => dismiss(item.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </MiniButton>
                    }
                  />
                ))}
              </Section>
            )}

            {/* ── MESSAGES ────────────────────────────────────────────── */}
            {unreadThreads.length > 0 && (
              <Section title={`Messages (${unreadTotal})`}>
                {unreadThreads.map((thread: MessageThread) => (
                  <FeedRow
                    key={`msg-${thread.username}`}
                    icon={<MessageSquare className="h-4 w-4" />}
                    title={thread.username}
                    subtitle={thread.lastBody ?? 'New message'}
                    meta={formatAge(thread.lastAt)}
                    onClick={() => goMessages(thread.username)}
                    actions={
                      <span className="rounded-md bg-[#00FFD1]/20 px-1.5 py-0.5 text-[9px] font-bold text-[#00FFD1]">
                        {thread.unread}
                      </span>
                    }
                  />
                ))}
              </Section>
            )}

            {/* ── DAILY REWARD (unchanged behaviour) ──────────────────── */}
            <Section title="System">
              <div
                className={`rounded-xl border p-2 transition-all ${
                  dailyAvailable
                    ? 'border-[#00FFD1]/30 bg-[#00FFD1]/5 hover:bg-[#00FFD1]/10'
                    : 'bg-white/2 border-white/5'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                      dailyAvailable
                        ? 'bg-[#00FFD1]/20 text-[#00FFD1]'
                        : 'bg-white/5 text-white/30'
                    }`}
                  >
                    <Gift className={`h-4 w-4 ${dailyAvailable ? 'animate-bounce' : ''}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h5
                      className={`text-[11px] font-black uppercase leading-none tracking-wider ${
                        dailyAvailable ? 'text-[#00FFD1]' : 'text-white/60'
                      }`}
                    >
                      Daily Reward
                    </h5>
                    <p className="mt-1 truncate text-[8px] uppercase tracking-widest text-white/40">
                      {dailyAvailable ? '20 Neon Bucks ready' : 'Claimed today'}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {dailyAvailable ? (
                      <button
                        onClick={onClaimDaily}
                        className="pointer-events-auto cursor-pointer rounded-full bg-[#00FFD1] px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-[#081616] shadow-[0_0_10px_rgba(0,255,209,0.3)] transition-transform hover:scale-[1.02] hover:bg-[#00e0b7] active:scale-95"
                      >
                        Claim
                      </button>
                    ) : (
                      <div className="mr-1 flex items-center gap-0.5 text-[8px] font-bold uppercase text-[#00FFD1]">
                        <Check className="h-3 w-3 animate-pulse" /> Done
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Nothing waiting anywhere: say so once, instead of an empty
                  panel that reads as broken. */}
              {signedIn &&
                invites.length === 0 &&
                incoming.length === 0 &&
                accepted.length === 0 &&
                unreadThreads.length === 0 && (
                  <div className="bg-white/2 rounded-xl border border-white/5 p-2.5">
                    <div className="flex gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-500/10 text-[#00FFD1]">
                        <Sparkles className="h-4 w-4" />
                      </div>
                      <div className="flex-1 space-y-1">
                        <h5 className="text-xs font-black uppercase text-white/80">
                          All clear
                        </h5>
                        <p className="text-[9px] uppercase leading-relaxed tracking-wider text-white/40">
                          No invites, requests or unread messages. Challenge a friend
                          from the menu to start a private wager.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

              {!signedIn && (
                <div className="bg-white/2 rounded-xl border border-white/5 p-2.5">
                  <div className="flex gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-500/10 text-[#00FFD1]">
                      <Sparkles className="h-4 w-4" />
                    </div>
                    <div className="flex-1 space-y-1">
                      <h5 className="text-xs font-black uppercase text-white/80">
                        Arcade Welcome
                      </h5>
                      <p className="text-[9px] uppercase leading-relaxed tracking-wider text-white/40">
                        Welcome to Neon Arcade! Sign in to get wager invites, friend
                        requests and messages here.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </Section>

            {/* ── FOOTER — the two sidebar panels ─────────────────────── */}
            {signedIn && (
              <div className="grid grid-cols-2 gap-2 border-t border-white/5 pt-3">
                <button
                  type="button"
                  onClick={() => goMessages()}
                  className="cursor-pointer rounded-lg border border-[#00FFD1]/20 py-2 text-[9px] uppercase tracking-[0.2em] text-white/50 transition-colors hover:border-[#00FFD1]/60 hover:text-[#00FFD1]"
                >
                  All messages
                </button>
                <button
                  type="button"
                  onClick={goFriends}
                  className="cursor-pointer rounded-lg border border-[#00FFD1]/20 py-2 text-[9px] uppercase tracking-[0.2em] text-white/50 transition-colors hover:border-[#00FFD1]/60 hover:text-[#00FFD1]"
                >
                  Friends
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SMALL PIECES
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[9px] uppercase tracking-[0.25em] text-white/30">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

/** The invite card: who, what, and the JOIN that opens the waiting room. */
function InviteRow({
  item,
  onJoin,
  onDecline,
}: {
  item: NotificationItem
  onJoin: () => void
  onDecline: () => void
}) {
  return (
    <div className="rounded-xl border border-[#00FFD1]/30 bg-[#00FFD1]/5 p-2.5">
      <div className="flex items-center gap-2.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#00FFD1]/20 text-[#00FFD1]">
          <Swords className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h5 className="truncate text-[11px] font-black uppercase leading-none tracking-wider text-white">
            {item.from}
          </h5>
          <p className="mt-1 truncate text-[8px] uppercase tracking-widest text-[#00FFD1]/70">
            {item.body}
          </p>
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onJoin}
          className="flex-1 cursor-pointer rounded-full bg-[#00FFD1] py-1.5 text-[9px] font-black uppercase tracking-wider text-[#081616] shadow-[0_0_10px_rgba(0,255,209,0.3)] transition-transform hover:scale-[1.02] active:scale-95"
        >
          Join
        </button>
        <button
          type="button"
          onClick={onDecline}
          className="cursor-pointer rounded-full border border-white/10 px-3 py-1.5 text-[9px] uppercase tracking-wider text-white/40 transition-colors hover:border-white/30 hover:text-white/80"
        >
          Later
        </button>
      </div>
    </div>
  )
}

function FeedRow({
  icon,
  title,
  subtitle,
  meta,
  onClick,
  actions,
}: {
  icon: ReactNode
  title: string
  subtitle: string
  meta?: string
  onClick?: () => void
  actions?: ReactNode
}) {
  return (
    <div className="bg-white/2 flex items-center gap-2.5 rounded-xl border border-white/5 p-2 transition-colors hover:border-[#00FFD1]/25 hover:bg-[#00FFD1]/5">
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={`flex min-w-0 flex-1 items-center gap-2.5 text-left ${
          onClick ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-500/10 text-[#00FFD1]">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-black uppercase leading-none tracking-wider text-white/90">
            {title}
          </span>
          {/* Message previews are raw user text — React escapes it. */}
          <span className="mt-1 block truncate text-[9px] tracking-wider text-white/40">
            {subtitle}
          </span>
        </span>
        {meta && <span className="shrink-0 text-[8px] text-white/25">{meta}</span>}
      </button>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  )
}

function MiniButton({
  label,
  onClick,
  disabled = false,
  tone = 'neon',
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  tone?: 'neon' | 'danger' | 'quiet'
  children: ReactNode
}) {
  const toneClasses =
    tone === 'danger'
      ? 'border-red-400/30 text-red-300/80 hover:border-red-400/60 hover:bg-red-500/10'
      : tone === 'quiet'
        ? 'border-white/10 text-white/30 hover:border-white/30 hover:text-white/70'
        : 'border-[#00FFD1]/30 text-[#00FFD1]/80 hover:border-[#00FFD1]/60 hover:bg-[#00FFD1]/10'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClasses}`}
    >
      {children}
    </button>
  )
}
