/**
 * usePresence — the client half of the social socket wiring
 * =========================================================
 * The server (apps/server/src/socket/social.ts) tracks which AUTHED wallets
 * hold a "/" socket and pushes each user the list of THEIR friends who are
 * online right now. This module is the only place the web app listens to it.
 *
 * WIRE CONTRACT (must match socket/social.ts exactly)
 *   C→S  social:presence                       — no payload, "resend my list"
 *   S→C  social:friendsOnline { usernames[] }   — accepted friends online NOW
 *   S→C  social:message { fromUsername, body, createdAt }
 *   S→C  social:friendRequest { fromUsername }
 *
 * ‼️ SECURITY: every payload above carries USERNAMES only. If a wallet ever
 * shows up in one of these events, that is a server bug — this file must
 * never learn to read one.
 *
 * The socket itself is the app-wide singleton from hooks/useGameSocket.ts —
 * the same authenticated connection every online game already uses. We never
 * open a second one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { connectGameSocket } from '../../hooks/useGameSocket'
import { AUTH_TOKEN_KEY } from '../../hooks/useBackendAuth'

// ─────────────────────────────────────────────────
// EVENT NAMES + PAYLOADS
// ─────────────────────────────────────────────────

export const SOCIAL_EVENTS = {
  /** C→S: ask the server to re-send my ONLINE FRIENDS list. */
  presence: 'social:presence',
  /** S→C: the full list of friends online right now (not a delta). */
  friendsOnline: 'social:friendsOnline',
  /** S→C: a direct message just arrived. */
  message: 'social:message',
  /** S→C: somebody sent me a friend request. */
  friendRequest: 'social:friendRequest',
  /**
   * S→C: somebody ACCEPTED the request I sent them. The requester gets no
   * other signal — the accept happens over HTTP on the other person's
   * machine — so without this the nav-bar feed could only ever show one half
   * of a friendship forming.
   */
  friendAccepted: 'social:friendAccepted',
} as const

/** S→C `social:message`. `createdAt` is an ISO string. */
export interface SocialMessageEvent {
  fromUsername: string
  body: string
  createdAt: string
}

/** S→C `social:friendRequest` — and `social:friendAccepted`, same shape. */
export interface SocialFriendRequestEvent {
  fromUsername: string
}

// ─────────────────────────────────────────────────
// AUTH GATE
// ─────────────────────────────────────────────────

/**
 * Is there a backend JWT stored? Without one the socket handshake would be
 * rejected and every social route answers 401, so the panels show a sign-in
 * message instead of spraying failing requests at the server.
 */
export function hasAuthToken(): boolean {
  try {
    return !!localStorage.getItem(AUTH_TOKEN_KEY)
  } catch {
    // Private-mode Safari and friends can throw on localStorage access.
    return false
  }
}

// ─────────────────────────────────────────────────
// useSocialEvent — subscribe to one S→C event
// ─────────────────────────────────────────────────
/**
 * Bind a handler to a social socket event for the lifetime of the component.
 *
 * The handler is kept in a ref so callers can pass an inline arrow function
 * without re-subscribing on every render (a re-subscribe storm on a shared
 * singleton socket is how listener leaks start).
 *
 * `enabled: false` unbinds — used to keep signed-out users off the socket.
 */
export function useSocialEvent<T>(
  event: string,
  handler: (payload: T) => void,
  enabled = true
): void {
  const handlerRef = useRef(handler)

  useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  useEffect(() => {
    if (!enabled || !hasAuthToken()) return

    const socket = connectGameSocket()
    const listener = (payload: T) => {
      try {
        handlerRef.current(payload)
      } catch (err) {
        // A throwing UI handler must never kill the shared game socket.
        console.error(`[social] handler for ${event} threw:`, err)
      }
    }

    socket.on(event, listener)
    return () => {
      socket.off(event, listener)
    }
  }, [event, enabled])
}

// ─────────────────────────────────────────────────
// useOnlineFriends — THE sidebar's ONLINE FRIENDS source
// ─────────────────────────────────────────────────

/** Defensive parse: only strings survive, whatever the server sent. */
function readUsernames(payload: unknown): string[] {
  const list = (payload as { usernames?: unknown } | null)?.usernames
  if (!Array.isArray(list)) return []
  return list.filter((entry): entry is string => typeof entry === 'string')
}

export interface OnlineFriends {
  /** Canonically-cased usernames, sorted by the server. */
  usernames: string[]
  /** Lower-cased lookup set — use `isOnline()` rather than reading this. */
  online: Set<string>
  /** Case-insensitive membership test against the live list. */
  isOnline: (username: string) => boolean
  /**
   * Has a `social:friendsOnline` payload arrived yet? An EMPTY list is a
   * perfectly good answer ("nobody is online"), so length can't be used to
   * tell "no data yet" from "no friends online" — this flag can.
   */
  received: boolean
  /**
   * THE presence question every row should ask: the live list once we have
   * one, otherwise the `online` flag the REST payload was fetched with.
   * Without this a friend who went offline after the fetch would keep a
   * green dot until the list was refetched.
   */
  onlineOf: (username: string, fallback: boolean) => boolean
  /** Ask the server for a fresh list (rate limited to 30/min per wallet). */
  refresh: () => void
}

/**
 * Live "which of my friends are online" set.
 *
 * The server pushes the full list on connect and again on every presence
 * flip, so there is nothing to poll — we only ask for a resend on mount and
 * after a reconnect (a dropped socket means we missed every flip in between).
 */
export function useOnlineFriends(enabled = true): OnlineFriends {
  const [usernames, setUsernames] = useState<string[]>([])
  const [received, setReceived] = useState(false)

  const refresh = useCallback(() => {
    if (!hasAuthToken()) return
    // Emits made while disconnected are buffered by socket.io and flushed on
    // connect, so this is safe to call before the handshake completes.
    connectGameSocket().emit(SOCIAL_EVENTS.presence)
  }, [])

  useSocialEvent<unknown>(
    SOCIAL_EVENTS.friendsOnline,
    (payload) => {
      setUsernames(readUsernames(payload))
      setReceived(true)
    },
    enabled
  )

  useEffect(() => {
    if (!enabled || !hasAuthToken()) return

    const socket = connectGameSocket()
    refresh()

    // A reconnect means we were offline for a while: re-ask instead of
    // trusting a list that may be minutes stale.
    socket.on('connect', refresh)
    return () => {
      socket.off('connect', refresh)
    }
  }, [enabled, refresh])

  const online = useMemo(
    () => new Set(usernames.map((name) => name.toLowerCase())),
    [usernames]
  )

  const isOnline = useCallback(
    (username: string) => online.has(username.toLowerCase()),
    [online]
  )

  const onlineOf = useCallback(
    (username: string, fallback: boolean) =>
      received ? online.has(username.toLowerCase()) : fallback,
    [online, received]
  )

  return { usernames, online, isOnline, received, onlineOf, refresh }
}
