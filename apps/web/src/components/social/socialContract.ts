/**
 * SOCIAL CONTRACT — the tiny vocabulary the sidebar and its panels share
 * ======================================================================
 * SidebarMenu hosts several panels that are owned by DIFFERENT modules
 * (Friends/Messages here, Stats/Leaderboard/History elsewhere, the private
 * wager room elsewhere again). This file is the only thing they all import,
 * so none of them can drift on a prop name, a query key or an event name.
 *
 * ‼️ SECURITY: every identifier that crosses these boundaries is a
 * `username`. A WALLET IS PRIVATE and never travels between users — there is
 * deliberately no type in this file that carries one.
 *
 * It has no React dependency on purpose: types + constants only.
 */

// ─────────────────────────────────────────────────
// PANEL PROPS
// ─────────────────────────────────────────────────

/**
 * Every sidebar panel takes exactly this. `onClose` means "go BACK to the
 * menu" (the panel renders it as the ‹ chevron in its own header), not
 * "close the drawer" — the drawer is closed by its backdrop / X button.
 *
 * StatsPanel, LeaderboardPanel and HistoryPanel already have this shape;
 * FriendsPanel and MessagesPanel extend it with a couple of extras below.
 */
export interface SocialPanelProps {
  onClose?: () => void
}

// ─────────────────────────────────────────────────
// PRIVATE-WAGER INVITE HANDOFF  (the C3 integration point)
// ─────────────────────────────────────────────────

/**
 * THE prop contract for the invite button that appears on hover, on the
 * RIGHT of every ONLINE friend row (sidebar list + Friends panel).
 *
 * The private-wager module supplies it; it receives the friend's USERNAME
 * and nothing else, and is expected to open the game/mode picker and then
 * `private:create` + `private:invite` over the socket.
 *
 *   <SidebarMenu onInviteFriend={(username) => openWagerPicker(username)} />
 */
export type InviteFriendHandler = (username: string) => void

/**
 * DEFAULT path when no `onInviteFriend` prop was passed down: the row
 * dispatches this window event instead, so the private-wager UI can be wired
 * from anywhere in the tree without threading a prop through every screen
 * that renders a sidebar.
 *
 * ‼️ This string MUST stay identical to `PRIVATE_WAGER_INVITE_EVENT` in
 * `PrivateWagerInvite.tsx` — that module's `PrivateWagerHost` listens for it
 * (via `usePrivateWagerInviteRequests`) and opens the game/mode picker. It is
 * mirrored rather than imported so neither file has to depend on the other
 * (they are built in separate workstreams); the payload shape it reads is
 * exactly `{ detail: { username } }`.
 *
 *   window.addEventListener(PRIVATE_INVITE_EVENT, (e) => {
 *     const { username } = (e as CustomEvent<PrivateInviteDetail>).detail
 *   })
 */
export const PRIVATE_INVITE_EVENT = 'neon-arcade:private-wager-invite'

/** Payload of {@link PRIVATE_INVITE_EVENT}. Username only — never a wallet. */
export interface PrivateInviteDetail {
  username: string
}

/**
 * Call the invite handler if there is one, otherwise announce the intent on
 * the window (which is how the private-wager host hears it — see above).
 * ONE helper so the sidebar row and the Friends panel row can never behave
 * differently.
 *
 * NOTE FOR HOSTS: passing `onInviteFriend` SUPPRESSES the window event, so a
 * host that wants the standard `PrivateWagerHost` flow should simply not pass
 * the prop.
 */
export function requestPrivateInvite(
  username: string,
  handler?: InviteFriendHandler
): void {
  if (handler) {
    handler(username)
    return
  }
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<PrivateInviteDetail>(PRIVATE_INVITE_EVENT, {
      detail: { username },
    })
  )
}

// ─────────────────────────────────────────────────
// REACT-QUERY KEYS
// ─────────────────────────────────────────────────
/**
 * The sidebar (badges) and the panels (lists) read the SAME endpoints, so
 * they must use the same cache keys — otherwise accepting a friend request
 * inside the panel would leave a stale badge behind it.
 */
export const SOCIAL_KEYS = {
  /** GET /api/profile/me — my own account, incl. the ELO behind my rank. */
  me: ['profile', 'me'] as const,
  /** GET /api/social/friends — accepted + incoming + outgoing, in one. */
  friends: ['social', 'friends'] as const,
  /** GET /api/social/messages — thread list + unread total. */
  threads: ['social', 'threads'] as const,
  /** GET /api/social/search?q= — one entry per debounced query. */
  search: (query: string) => ['social', 'search', query.toLowerCase()] as const,
  /** GET /api/social/messages/:username — one conversation. */
  thread: (username: string) =>
    ['social', 'thread', username.toLowerCase()] as const,
}

// ─────────────────────────────────────────────────
// SMALL SHARED HELPERS
// ─────────────────────────────────────────────────

/**
 * Turn any thrown value into something a player can read. ApiError already
 * carries the server's message (including the deliberately generic
 * friend-request failure), so we surface it as-is and only invent text when
 * we got something that isn't an Error at all.
 *
 * Local on purpose: the stats panels have their own copy, and neither module
 * should be able to break the other by renaming a helper.
 */
export function readableApiError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

/**
 * Usernames are compared case-insensitively everywhere on the client: the
 * server's uniqueness index is on `lower(username)`, so "Vanguard" and
 * "vanguard" are the same account and must never render as two people.
 */
export function sameUser(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

/** `14:03` — the timestamp format used by messages and thread previews. */
export function formatTime(iso: string | Date): string {
  const date = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** `now` / `4m` / `3h` / `2d` — compact age for the thread list. */
export function formatAge(iso: string | Date | null | undefined): string {
  if (!iso) return ''
  const date = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}
