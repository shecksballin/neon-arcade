/**
 * FRIENDS PANEL — search, requests and the friend list (sidebar panel)
 * ====================================================================
 * Four stacked sections, all driven by GET /api/social/friends plus a
 * debounced GET /api/social/search:
 *
 *   SEARCH     type ≥ 2 characters → up to 20 username matches, each with a
 *              single contextual action (add / accept / already friends)
 *   INCOMING   requests sent to me      → accept or decline
 *   OUTGOING   requests I sent          → cancel (same endpoint as remove)
 *   FRIENDS    accepted both ways       → message, invite, remove
 *
 * ‼️ SECURITY (design contract):
 *   - USERNAMES ONLY. Nothing on this screen knows a wallet exists, and the
 *     server would not send one if it did.
 *   - NO ENUMERATION. The search box refuses to query below 2 characters,
 *     the server caps results at 20 prefix/exact matches, and every
 *     friend-request failure comes back as ONE generic message — so the UI
 *     must not try to explain *why* something failed beyond what it was told.
 *   - Usernames are rendered as TEXT (React escapes them). Never
 *     dangerouslySetInnerHTML.
 *
 * Presence: the online dot merges the `online` flag from the REST payload
 * (correct at fetch time) with the live `social:friendsOnline` set, so the
 * dots keep updating without refetching the list.
 *
 * RANK: every row's chip is derived from the player's RP when the payload
 * carries it (search hits always do — `rankRpOf` reads the new `rp` field or
 * the legacy `elo` mirror), which is what gives "SILVER III" instead of a
 * bare "SILVER". Rows with no RP fall back to the tier the server sent.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronLeft,
  LogIn,
  MessageSquare,
  RefreshCw,
  Search,
  Swords,
  UserPlus,
  UserX,
  X as XIcon,
} from 'lucide-react'
import { rankRpOf, socialApi } from '../../lib/api'
import type { FriendEntry, SearchUser } from '../../lib/api'
import {
  SOCIAL_KEYS,
  readableApiError,
  requestPrivateInvite,
  sameUser,
  type InviteFriendHandler,
  type SocialPanelProps,
} from './socialContract'
import { RowButton, UserRow } from './UserRow'
import {
  SOCIAL_EVENTS,
  hasAuthToken,
  useOnlineFriends,
  useSocialEvent,
} from './usePresence'
// Same store the sidebar's ONLINE FRIENDS rows read — a friend who has
// invited you looks the same wherever their row is drawn.
import { useNotifications } from '../../notifications/NotificationsStore'

/** How long the search box waits after the last keystroke (server: 20/min). */
const SEARCH_DEBOUNCE_MS = 300

/** The server ignores anything shorter — no enumeration from 1 character. */
const SEARCH_MIN_CHARS = 2

export interface FriendsPanelProps extends SocialPanelProps {
  /**
   * Private-wager invite. Supplied by the private-wager module; receives the
   * friend's USERNAME. When absent the button still works and announces
   * itself on the window instead (see socialContract.requestPrivateInvite).
   */
  onInviteFriend?: InviteFriendHandler
  /** Open the Messages panel on this conversation. Supplied by SidebarMenu. */
  onMessage?: (username: string) => void
  /**
   * JOIN a private wager this friend already invited me to. Supplied by
   * SidebarMenu so the drawer can close itself first (the waiting room renders
   * UNDER the drawer). Without it the row falls back to accepting in place,
   * which still works — it just leaves the drawer covering the room.
   */
  onJoinPrivateWager?: (roomId: string) => void
}

/** What I already am to a searched user — drives the row's single action. */
type Relation = 'none' | 'friend' | 'incoming' | 'outgoing'

export default function FriendsPanel({
  onClose,
  onInviteFriend,
  onMessage,
  onJoinPrivateWager,
}: FriendsPanelProps) {
  const queryClient = useQueryClient()
  const signedIn = hasAuthToken()
  const { inviteFrom, acceptInvite } = useNotifications()
  const joinInvite = onJoinPrivateWager ?? acceptInvite

  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const [error, setError] = useState<string | null>(null)

  // ── debounce ───────────────────────────────────────────────────────────
  useEffect(() => {
    const trimmed = term.trim()
    const timer = setTimeout(() => setDebounced(trimmed), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term])

  // ── data ───────────────────────────────────────────────────────────────
  const friendsQuery = useQuery({
    queryKey: SOCIAL_KEYS.friends,
    queryFn: socialApi.friends,
    enabled: signedIn,
  })

  const searchQuery = useQuery({
    queryKey: SOCIAL_KEYS.search(debounced),
    queryFn: () => socialApi.search(debounced),
    enabled: signedIn && debounced.length >= SEARCH_MIN_CHARS,
    // A repeated query inside 15s reuses the cache instead of spending
    // another request from the 20/min search budget.
    staleTime: 15_000,
  })

  const presence = useOnlineFriends(signedIn)

  // A request that lands while the panel is open must show up immediately.
  useSocialEvent(
    SOCIAL_EVENTS.friendRequest,
    () => {
      void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.friends })
    },
    signedIn
  )

  // ── mutations (one object: every action is the same shape) ─────────────
  const action = useMutation({
    mutationFn: ({
      kind,
      username,
    }: {
      kind: 'request' | 'accept' | 'decline' | 'remove'
      username: string
    }) => {
      switch (kind) {
        case 'request':
          return socialApi.requestFriend(username)
        case 'accept':
          return socialApi.acceptFriend(username)
        case 'decline':
          return socialApi.declineFriend(username)
        case 'remove':
          return socialApi.removeFriend(username)
      }
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.friends })
      // Removing a friend also kills the conversation's authorization, so
      // the thread list has to be re-read.
      void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.threads })
      // Refresh presence: a brand-new friendship has no flip of its own.
      presence.refresh()
    },
    onError: (err) =>
      setError(readableApiError(err, 'That did not work — try again')),
  })

  const busyWith = action.isPending ? action.variables?.username ?? null : null

  const friends = friendsQuery.data?.friends ?? []
  const incoming = friendsQuery.data?.incoming ?? []
  const outgoing = friendsQuery.data?.outgoing ?? []

  /** Live-or-fetched presence for one row (see usePresence.onlineOf). */
  const isOnline = (entry: { username: string; online: boolean }) =>
    presence.onlineOf(entry.username, entry.online)

  /** What a search hit already is to me. */
  const relationOf = useMemo(() => {
    const map = new Map<string, Relation>()
    for (const f of friends) map.set(f.username.toLowerCase(), 'friend')
    for (const f of incoming) map.set(f.username.toLowerCase(), 'incoming')
    for (const f of outgoing) map.set(f.username.toLowerCase(), 'outgoing')
    return (username: string): Relation =>
      map.get(username.toLowerCase()) ?? 'none'
  }, [friends, incoming, outgoing])

  // ── render ─────────────────────────────────────────────────────────────
  const searching = debounced.length >= SEARCH_MIN_CHARS
  const results = searchQuery.data?.users ?? []

  return (
    <div className="flex h-full min-h-0 flex-col font-mono text-white">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[#00ffd1]/20 bg-gradient-to-r from-[#00ffd1]/10 to-transparent p-4">
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Back"
            className="cursor-pointer text-white/50 transition-colors hover:text-[#00ffd1]"
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <h3 className="flex-1 text-sm font-black uppercase tracking-[0.2em] text-[#00ffd1]">
          Friends
        </h3>
        <button
          onClick={() => void friendsQuery.refetch()}
          aria-label="Refresh friends"
          disabled={friendsQuery.isFetching}
          className="cursor-pointer text-white/40 transition-colors hover:text-[#00ffd1] disabled:opacity-40"
        >
          <RefreshCw
            size={14}
            className={friendsQuery.isFetching ? 'animate-spin' : ''}
          />
        </button>
      </div>

      {/* Search box */}
      <div className="border-b border-[#00ffd1]/10 p-4">
        <div className="flex items-center gap-2 rounded-lg border border-[#00ffd1]/20 bg-black/40 px-3 py-2 focus-within:border-[#00ffd1]/50">
          <Search size={14} className="shrink-0 text-[#00ffd1]/60" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            // The server's username charset — typing a wallet in here is
            // not a thing that can work, by design.
            maxLength={20}
            spellCheck={false}
            autoComplete="off"
            placeholder="SEARCH USERNAME"
            aria-label="Search players by username"
            className="min-w-0 flex-1 bg-transparent text-xs uppercase tracking-widest text-white outline-none placeholder:text-white/25"
          />
          {term && (
            <button
              onClick={() => setTerm('')}
              aria-label="Clear search"
              className="cursor-pointer text-white/40 hover:text-[#00ffd1]"
            >
              <XIcon size={14} />
            </button>
          )}
        </div>
        <div className="mt-2 text-[9px] uppercase tracking-wider text-white/30">
          Exact or starts-with, {SEARCH_MIN_CHARS}+ characters — usernames only
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-[10px] uppercase tracking-wider text-red-300">
          {error}
        </div>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {!signedIn ? (
          <Empty text="Sign in to add friends" />
        ) : (
          <>
            {/* SEARCH RESULTS */}
            {searching && (
              <Section title={`Results for "${debounced}"`}>
                {searchQuery.isPending ? (
                  <Empty text="Searching…" />
                ) : searchQuery.isError ? (
                  <Empty text="Search unavailable right now" />
                ) : results.length === 0 ? (
                  <Empty text="No players found" />
                ) : (
                  results.map((user: SearchUser) => (
                    <UserRow
                      key={user.username}
                      username={user.username}
                      rank={user.rank}
                      rp={rankRpOf(user)}
                      online={presence.onlineOf(user.username, user.online)}
                      actions={
                        <SearchAction
                          relation={relationOf(user.username)}
                          busy={sameUser(busyWith, user.username)}
                          onAdd={() =>
                            action.mutate({
                              kind: 'request',
                              username: user.username,
                            })
                          }
                          onAccept={() =>
                            action.mutate({
                              kind: 'accept',
                              username: user.username,
                            })
                          }
                        />
                      }
                    />
                  ))
                )}
              </Section>
            )}

            {/* INCOMING */}
            {incoming.length > 0 && (
              <Section title={`Incoming (${incoming.length})`}>
                {incoming.map((entry: FriendEntry) => (
                  <UserRow
                    key={entry.username}
                    username={entry.username}
                    rank={entry.rank}
                    rp={rankRpOf(entry)}
                    online={isOnline(entry)}
                    actions={
                      <>
                        <RowButton
                          label={`Accept ${entry.username}`}
                          disabled={sameUser(busyWith, entry.username)}
                          onClick={() =>
                            action.mutate({
                              kind: 'accept',
                              username: entry.username,
                            })
                          }
                        >
                          <Check size={14} />
                        </RowButton>
                        <RowButton
                          label={`Decline ${entry.username}`}
                          tone="danger"
                          disabled={sameUser(busyWith, entry.username)}
                          onClick={() =>
                            action.mutate({
                              kind: 'decline',
                              username: entry.username,
                            })
                          }
                        >
                          <XIcon size={14} />
                        </RowButton>
                      </>
                    }
                  />
                ))}
              </Section>
            )}

            {/* OUTGOING */}
            {outgoing.length > 0 && (
              <Section title={`Sent (${outgoing.length})`}>
                {outgoing.map((entry: FriendEntry) => (
                  <UserRow
                    key={entry.username}
                    username={entry.username}
                    rank={entry.rank}
                    rp={rankRpOf(entry)}
                    online={isOnline(entry)}
                    subtitle={
                      <span className="text-[9px] uppercase tracking-[0.15em] text-white/35">
                        Request sent
                      </span>
                    }
                    actions={
                      <RowButton
                        label={`Cancel request to ${entry.username}`}
                        tone="danger"
                        disabled={sameUser(busyWith, entry.username)}
                        onClick={() =>
                          action.mutate({
                            kind: 'remove',
                            username: entry.username,
                          })
                        }
                      >
                        <XIcon size={14} />
                      </RowButton>
                    }
                  />
                ))}
              </Section>
            )}

            {/* FRIENDS */}
            <Section title={`Friends (${friends.length})`}>
              {friendsQuery.isPending ? (
                <Empty text="Loading…" />
              ) : friendsQuery.isError ? (
                <Empty
                  text={readableApiError(
                    friendsQuery.error,
                    'Could not load your friends'
                  )}
                />
              ) : friends.length === 0 ? (
                <Empty text="No friends yet — search a username above" />
              ) : (
                friends.map((entry: FriendEntry) => {
                  // A live invite FROM this friend turns the row around: JOIN
                  // comes first, and the rank line says who is waiting.
                  const invite = inviteFrom(entry.username)
                  return (
                    <UserRow
                      key={entry.username}
                      username={entry.username}
                      rank={entry.rank}
                      rp={rankRpOf(entry)}
                      online={isOnline(entry)}
                      onClick={onMessage ? () => onMessage(entry.username) : undefined}
                      subtitle={
                        invite ? (
                          <span className="flex animate-pulse items-center gap-1 truncate text-[9px] uppercase tracking-[0.15em] text-[#00ffd1]">
                            <Swords size={10} className="shrink-0" />
                            Invited you · {invite.body}
                          </span>
                        ) : undefined
                      }
                      actions={
                        <>
                          {invite?.invite && (
                            <RowButton
                              label={`Join ${entry.username}'s private wager`}
                              onClick={() => joinInvite(invite.invite!.roomId)}
                            >
                              <LogIn size={14} />
                            </RowButton>
                          )}
                          {onMessage && (
                            <RowButton
                              label={`Message ${entry.username}`}
                              onClick={() => onMessage(entry.username)}
                            >
                              <MessageSquare size={14} />
                            </RowButton>
                          )}
                          {/* Invite is only meaningful while they are online —
                              the private room needs both players connected. */}
                          {isOnline(entry) && (
                            <RowButton
                              label={`Invite ${entry.username} to a private wager`}
                              onClick={() =>
                                requestPrivateInvite(entry.username, onInviteFriend)
                              }
                            >
                              <Swords size={14} />
                            </RowButton>
                          )}
                          <RowButton
                            label={`Remove ${entry.username}`}
                            tone="danger"
                            disabled={sameUser(busyWith, entry.username)}
                            onClick={() =>
                              action.mutate({
                                kind: 'remove',
                                username: entry.username,
                              })
                            }
                          >
                            <UserX size={14} />
                          </RowButton>
                        </>
                      }
                    />
                  )
                })
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────
// SMALL PIECES
// ─────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 pl-2 text-[10px] uppercase tracking-[0.2em] text-white/40">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="px-2 py-3 text-[10px] uppercase tracking-wider text-white/30">
      {text}
    </div>
  )
}

/**
 * The single action a search hit gets. Note that "already friends" and
 * "request pending" are derived from MY OWN friend list — never from an
 * error the server returned, which is deliberately uninformative.
 */
function SearchAction({
  relation,
  busy,
  onAdd,
  onAccept,
}: {
  relation: Relation
  busy: boolean
  onAdd: () => void
  onAccept: () => void
}) {
  if (relation === 'friend') {
    return (
      <span className="px-1 text-[9px] uppercase tracking-[0.15em] text-[#00ffd1]/60">
        Friends
      </span>
    )
  }
  if (relation === 'outgoing') {
    return (
      <span className="px-1 text-[9px] uppercase tracking-[0.15em] text-white/35">
        Pending
      </span>
    )
  }
  if (relation === 'incoming') {
    return (
      <RowButton label="Accept request" disabled={busy} onClick={onAccept}>
        <Check size={14} />
      </RowButton>
    )
  }
  return (
    <RowButton label="Send friend request" disabled={busy} onClick={onAdd}>
      <UserPlus size={14} />
    </RowButton>
  )
}
