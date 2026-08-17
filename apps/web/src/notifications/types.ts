/**
 * NOTIFICATIONS — the vocabulary
 * ==============================
 * One notification covers every "something happened involving another player"
 * event the arcade has: a private-wager invite, a direct message, a friend
 * request, a friend request being accepted.
 *
 * ‼️ SECURITY: the ONLY identifier in this file is `from` — a USERNAME. A
 * wallet is private and never crosses between users, so there is deliberately
 * no field here that could carry one. Every string below is rendered as TEXT
 * (React escapes it); nothing in this module may ever reach for
 * dangerouslySetInnerHTML.
 *
 * NO React import on purpose — types + constants only, so the store, the nav
 * bar, the toasts and the settings screen can all share it without a cycle.
 */

import type { PrivateGameKey } from '../components/social/privateWagerCatalog'

// ─────────────────────────────────────────────────
// KINDS
// ─────────────────────────────────────────────────

export type NotificationKind =
  /** `private:invited` — somebody wants to play. Carries `invite`. */
  | 'invite'
  /** `social:message` — a direct message landed. */
  | 'message'
  /** `social:friendRequest` — somebody asked to be friends. */
  | 'friend_request'
  /** `social:friendAccepted` — they said yes to MY request. */
  | 'friend_accepted'

/** The live private-wager room behind an `invite` notification. */
export interface InviteDetail {
  /** The uuid `private:join` needs. Maps to nothing outside the server. */
  roomId: string
  gameKey: PrivateGameKey
  mode: string
  /**
   * Epoch ms at which the SERVER stops honouring this invite. We mirror its
   * 5-minute TTL rather than guessing, so a card can never outlive the room
   * it points at — which matters most for invites replayed after a match
   * (see the in-game queue in NotificationsStore).
   */
  expiresAt: number
}

export interface NotificationItem {
  /** Stable within a session. Invites use `invite:<roomId>` so a re-push of
   *  the same room replaces its card instead of stacking a second one. */
  id: string
  kind: NotificationKind
  /** The other player's USERNAME. Never a wallet. */
  from: string
  /** One line of body copy, already humanised. Rendered as text. */
  body: string
  /** Epoch ms of the newest event folded into this item. */
  createdAt: number
  read: boolean
  /** How many events are folded in (messages from one sender collapse). */
  count: number
  /** Present iff `kind === 'invite'`. */
  invite?: InviteDetail
}

// ─────────────────────────────────────────────────
// PREFERENCES
// ─────────────────────────────────────────────────
/**
 * What the player gets a POP-UP for. Nothing here affects the nav-bar
 * notification centre — turning pop-ups off makes them quiet, not invisible,
 * so a muted invite is still joinable from the bell (and from the friend's
 * row in the sidebar).
 */
export interface NotificationPrefs {
  /** Master switch for in-app pop-ups. */
  popups: boolean
  /** Pop up for private-wager invites. */
  invites: boolean
  /** Pop up for direct messages. */
  messages: boolean
  /** Pop up for friend requests + accepts. */
  friends: boolean
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  popups: true,
  invites: true,
  messages: true,
  friends: true,
}

/** localStorage key. Versioned so a later shape change can't half-parse. */
export const NOTIFICATION_PREFS_KEY = 'neon_arcade_notification_prefs_v1'

/** Which pref gates a pop-up for a given kind. */
export function prefKeyForKind(
  kind: NotificationKind
): keyof Omit<NotificationPrefs, 'popups'> {
  switch (kind) {
    case 'invite':
      return 'invites'
    case 'message':
      return 'messages'
    default:
      return 'friends'
  }
}

// ─────────────────────────────────────────────────
// TIMINGS
// ─────────────────────────────────────────────────

/** Server-side invite TTL (privateMatch.ts INVITE_TTL_MS). Mirrored. */
export const INVITE_TTL_MS = 5 * 60_000

/** How long a pop-up sits on screen before it fades itself out. */
export const TOAST_DURATION_MS: Record<NotificationKind, number> = {
  // Invites have buttons, so they get long enough to actually act on.
  invite: 20_000,
  message: 6_000,
  friend_request: 8_000,
  friend_accepted: 6_000,
}

/** Most pop-ups on screen at once — the rest wait their turn. */
export const MAX_VISIBLE_TOASTS = 3

/** Feed depth. Old rows fall off the bottom rather than growing forever. */
export const MAX_FEED_ITEMS = 40
