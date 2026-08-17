/**
 * SOCKET → NOTIFICATIONS — the single listener
 * ============================================
 * Mount ONE of these, app-level, gated on a finished account (the same gate
 * `PrivateWagerHost` uses — every event below rides the authed socket, which
 * only exists once a username + TOTP are set up).
 *
 * It renders nothing. Its whole job is to turn four server pushes into feed
 * entries:
 *
 *   private:invited      { roomId, fromUsername, gameKey, mode }  → an INVITE
 *   private:closed       { roomId }                → retires that invite card
 *   social:message       { fromUsername, body }    → a MESSAGE row
 *   social:friendRequest { fromUsername }          → a FRIEND REQUEST row
 *   social:friendAccepted{ fromUsername }          → "you are now friends"
 *
 * ‼️ EXACTLY ONE LISTENER PER EVENT. The game socket is a singleton, so a
 * second subscriber anywhere would double every notification. This is why
 * `usePrivateInvites` was removed from PrivateWagerInvite.tsx — see the note
 * left in its place.
 *
 * ‼️ SECURITY: every payload above carries USERNAMES only. Payloads are
 * defensively narrowed here (a malformed push is dropped, never rendered) and
 * every string ends up in a React text node.
 */

import { useEffect, useRef } from 'react'
import {
  isPrivateGameKey,
  privateWagerGameTitle,
  privateWagerModeLabel,
} from '../components/social/privateWagerCatalog'
import { SOCIAL_EVENTS, useSocialEvent } from '../components/social/usePresence'
import { useNotifications } from './NotificationsStore'
import { INVITE_TTL_MS } from './types'

/** Wire shape of `private:invited`. Every field is checked before use. */
interface InvitedPush {
  roomId?: unknown
  fromUsername?: unknown
  gameKey?: unknown
  mode?: unknown
  /** MS REMAINING on the server's own timer. Absent on an older server. */
  expiresIn?: unknown
}

/**
 * When does this invitation die, by THIS machine's clock?
 *
 * The remaining time has to come from the server. Invites are REPLAYED to a
 * fresh socket, so a reconnect or a reload delivers an invitation that is
 * already partway through its five-minute life — stamping `now + TTL` there
 * restarts a clock the server measures from the original invite, and the card
 * goes on offering a JOIN the server would refuse with `not_invited`.
 *
 * A DURATION, not a deadline: adding the server's remaining time to our own
 * clock is immune to skew between the two, where trusting an absolute
 * timestamp is not (a browser running a few minutes fast would read a
 * perfectly good deadline as already past and bin a live invitation).
 *
 * Clamped to [0, TTL]: a broken or hostile value can neither mint an immortal
 * card nor produce one that is born expired. The full-TTL fallback only
 * applies to a server that predates the field.
 */
function inviteExpiry(raw: unknown): number {
  const remaining =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.min(Math.max(raw, 0), INVITE_TTL_MS)
      : INVITE_TTL_MS
  return Date.now() + remaining
}

/** One-line preview for a message row/toast. Trimmed, never markup. */
function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat
}

export function NotificationsSocketBridge({ enabled = true }: { enabled?: boolean }) {
  const { push, removeInvite, clearAll } = useNotifications()

  // ── private:invited ─────────────────────────────────────────────────────
  useSocialEvent<InvitedPush>(
    'private:invited',
    (data) => {
      const { roomId, fromUsername, gameKey, mode, expiresIn } = data ?? {}
      if (
        typeof roomId !== 'string' ||
        typeof fromUsername !== 'string' ||
        typeof mode !== 'string' ||
        !fromUsername ||
        // An invite for a game this build has no catalog entry for could never
        // be joined — drop it rather than render a dead JOIN button.
        !isPrivateGameKey(gameKey)
      ) {
        return
      }
      push({
        kind: 'invite',
        // One row PER ROOM, so two invites from the same friend don't fold
        // into each other and lose a joinable room.
        id: `invite:${roomId}`,
        from: fromUsername,
        body: `${privateWagerGameTitle(gameKey)} · ${privateWagerModeLabel(gameKey, mode)}`,
        invite: {
          roomId,
          gameKey,
          mode,
          // Derived from the SERVER's remaining time — see inviteExpiry
          // for why the client must not compute this itself.
          expiresAt: inviteExpiry(expiresIn),
        },
      })
    },
    enabled
  )

  // ── private:closed — host left, or the room expired ─────────────────────
  useSocialEvent<{ roomId?: unknown }>(
    'private:closed',
    (data) => {
      if (typeof data?.roomId === 'string') removeInvite(data.roomId)
    },
    enabled
  )

  // ── social:message ──────────────────────────────────────────────────────
  useSocialEvent<{ fromUsername?: unknown; body?: unknown }>(
    SOCIAL_EVENTS.message,
    (data) => {
      const from = data?.fromUsername
      const body = data?.body
      if (typeof from !== 'string' || !from || typeof body !== 'string') return
      push({ kind: 'message', from, body: preview(body) })
    },
    enabled
  )

  // ── social:friendRequest ────────────────────────────────────────────────
  useSocialEvent<{ fromUsername?: unknown }>(
    SOCIAL_EVENTS.friendRequest,
    (data) => {
      const from = data?.fromUsername
      if (typeof from !== 'string' || !from) return
      push({ kind: 'friend_request', from, body: 'wants to be friends' })
    },
    enabled
  )

  // ── social:friendAccepted ───────────────────────────────────────────────
  useSocialEvent<{ fromUsername?: unknown }>(
    SOCIAL_EVENTS.friendAccepted,
    (data) => {
      const from = data?.fromUsername
      if (typeof from !== 'string' || !from) return
      push({ kind: 'friend_accepted', from, body: 'accepted your friend request' })
    },
    enabled
  )

  // Signing out (or losing the account) unmounts this bridge — App renders it
  // behind the same `hasAccount` gate as PrivateWagerHost. The feed belongs to
  // that session, so it dies with it: an invite addressed to the wallet that
  // just disconnected must not still be sitting in the bell for whoever signs
  // in next on this machine.
  const clearRef = useRef(clearAll)
  clearRef.current = clearAll
  useEffect(() => () => clearRef.current(), [])

  return null
}
