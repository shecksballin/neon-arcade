/**
 * NOTIFICATION STORE — one feed, three surfaces
 * =============================================
 * Everything the arcade wants to tell you about another player lands here
 * exactly once, and is then read by three places that must never disagree:
 *
 *   NAV BAR    the bell dropdown (NotificationCenter) — invites with a JOIN
 *              button, friend requests, unread conversations
 *   SIDEBAR    an ONLINE FRIENDS row grows a JOIN button when that friend has
 *              a live invite out to you (`inviteFrom`)
 *   POP-UPS    NotificationToasts — the in-app pop-up stack
 *
 * WHY A STORE AND NOT THREE LISTENERS
 * -----------------------------------
 * The game socket is an app-wide SINGLETON. Two components listening for
 * `private:invited` would each show the same invite, and the second one to
 * mount would silently double every toast. So there is exactly one listener
 * (NotificationsSocketBridge) and one piece of state (here).
 *
 * MID-MATCH SUPPRESSION (the rule the owner asked for)
 * ----------------------------------------------------
 * While `inGame` is true nothing pops up — a toast over a live match is a lost
 * point. Anything that arrives is parked in `queuedRef` and replayed the
 * moment the match ends, and toasts already on screen when a match STARTS are
 * pulled back into that same queue. Invites whose server-side TTL lapsed while
 * you were playing are dropped on the way out rather than shown as a card that
 * would fail to join.
 *
 * ‼️ SECURITY: usernames only (see types.ts). No wallet is representable here.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { getSocket } from '../hooks/useGameSocket'
import {
  DEFAULT_NOTIFICATION_PREFS,
  MAX_FEED_ITEMS,
  NOTIFICATION_PREFS_KEY,
  prefKeyForKind,
  type InviteDetail,
  type NotificationItem,
  type NotificationKind,
  type NotificationPrefs,
} from './types'

// ---------------------------------------------------------------------------
// PREFS — localStorage, fail-soft
// ---------------------------------------------------------------------------

/** Read the saved prefs. Anything unparseable falls back to the defaults. */
/**
 * The notification chime — the arcade's boot sting, repurposed (the boot
 * loader itself was removed). One shared element, rewound per chime so
 * bursts re-trigger cleanly; play() rejects before the first user gesture
 * (autoplay policy) and that rejection is deliberately swallowed — a
 * notification landing before ANY interaction just chimes silently.
 */
let notificationAudio: HTMLAudioElement | null = null;
function playNotificationSound(): void {
  if (typeof window === 'undefined') return;
  if (!notificationAudio) {
    notificationAudio = new Audio('/neonArcadeLoaderSoundfx.wav');
    notificationAudio.preload = 'auto';
    notificationAudio.volume = 0.4;
  }
  notificationAudio.currentTime = 0;
  void notificationAudio.play().catch(() => {});
}

function loadPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(NOTIFICATION_PREFS_KEY)
    if (!raw) return DEFAULT_NOTIFICATION_PREFS
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs> | null
    if (!parsed || typeof parsed !== 'object') return DEFAULT_NOTIFICATION_PREFS
    // Field-by-field so a half-written / older object can't produce
    // `undefined` where a boolean is expected.
    return {
      popups: parsed.popups ?? DEFAULT_NOTIFICATION_PREFS.popups,
      invites: parsed.invites ?? DEFAULT_NOTIFICATION_PREFS.invites,
      messages: parsed.messages ?? DEFAULT_NOTIFICATION_PREFS.messages,
      friends: parsed.friends ?? DEFAULT_NOTIFICATION_PREFS.friends,
    }
  } catch {
    // Private-mode Safari and friends throw on localStorage access.
    return DEFAULT_NOTIFICATION_PREFS
  }
}

function savePrefs(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* storage unavailable — the session still honours the choice */
  }
}

// ---------------------------------------------------------------------------
// LIST HELPERS (pure — every one of these is used by more than one setter)
// ---------------------------------------------------------------------------

/**
 * Newest-first insert with fold-in-place. Two events with the SAME id are one
 * row: three messages from `vanguard` are "3 new messages", not three rows.
 * A fold onto a row you had already read starts the count over, because that
 * row is about to go unread again.
 *
 * INVITES DO NOT COUNT UP. Their id is the roomId, so a re-push is the SAME
 * invitation arriving twice — which happens on every reconnect now that the
 * server replays live invites (see registerPrivateMatch). "+1 more" on a
 * single invitation would be a lie.
 */
function mergeItem(
  list: NotificationItem[],
  incoming: NotificationItem
): NotificationItem[] {
  const existing = list.find((item) => item.id === incoming.id)
  const repeatable = incoming.invite === undefined
  const merged: NotificationItem = existing
    ? {
        ...incoming,
        count: repeatable && !existing.read ? existing.count + 1 : 1,
        // A replayed invite must not un-read itself; a new message must.
        read: repeatable ? false : existing.read,
        // AN INVITE'S DEADLINE ONLY EVER MOVES EARLIER. The server sends its
        // own `expiresAt` so a replay should be identical — this is the guard
        // that keeps a re-announcement from silently extending a card's life
        // if that ever stops being true.
        invite:
          existing.invite && incoming.invite
            ? {
                ...incoming.invite,
                expiresAt: Math.min(
                  existing.invite.expiresAt,
                  incoming.invite.expiresAt
                ),
              }
            : incoming.invite,
      }
    : incoming
  return [merged, ...list.filter((item) => item.id !== incoming.id)].slice(
    0,
    MAX_FEED_ITEMS
  )
}

/** First occurrence of each id wins — used when re-queuing pulled toasts. */
function dedupeById(list: NotificationItem[]): NotificationItem[] {
  const seen = new Set<string>()
  const out: NotificationItem[] = []
  for (const item of list) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out.slice(0, MAX_FEED_ITEMS)
}

/** An invite the server would no longer honour. Non-invites never expire. */
function isDeadInvite(item: NotificationItem, now: number): boolean {
  return item.invite !== undefined && item.invite.expiresAt <= now
}

/** Drop expired invites; returns the SAME array when nothing changed, so a
 *  setState with it is a no-op React can bail out of. */
function pruneDead(list: NotificationItem[], now: number): NotificationItem[] {
  const next = list.filter((item) => !isDeadInvite(item, now))
  return next.length === list.length ? list : next
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/** What the socket bridge hands in. Everything else is filled in here. */
export interface NotificationInput {
  kind: NotificationKind
  /** The other player's USERNAME. */
  from: string
  body: string
  /** Fold key. Defaults to `<kind>:<from>` so repeats collapse into one row. */
  id?: string
  invite?: InviteDetail
}

/** A JOIN the user asked for; `PrivateWagerHost` consumes and clears it. */
export interface PendingJoin extends InviteDetail {
  fromUsername: string
}

/**
 * A room the user asked to HOST — the community board's "post a challenge"
 * flow. Same one-shot handoff shape as `PendingJoin`: the host consumes it,
 * navigates to the game, opens an OPEN private room, and calls `onCreated`
 * with the roomId so the panel can publish the challenge post.
 */
export interface PendingHost {
  gameKey: InviteDetail['gameKey']
  mode: string
  /** Fired once, with the server-assigned roomId, when the room exists. */
  onCreated?: (roomId: string) => void
}

export interface NotificationsApi {
  /** Newest first. Expired invites are pruned out. */
  items: NotificationItem[]
  /** Just the live private-wager invites, newest first. */
  invites: NotificationItem[]
  /** Unread rows — the bell's badge. */
  unread: number

  prefs: NotificationPrefs
  setPref: (key: keyof NotificationPrefs, value: boolean) => void

  /** Pop-ups currently on screen (empty while `inGame`). */
  toasts: NotificationItem[]
  dismissToast: (id: string) => void

  /** Called by the socket bridge — the ONLY way a notification is born. */
  push: (input: NotificationInput) => void

  markAllRead: () => void
  dismiss: (id: string) => void
  clearAll: () => void

  /** The live invite from this username, if any (case-insensitive). */
  inviteFrom: (username: string) => NotificationItem | null
  /** Take the invite: arms `pendingJoin` and retires the card. */
  acceptInvite: (roomId: string) => void
  /**
   * Arm a JOIN directly — no invite card involved. The community board's
   * challenge feed uses this: an open room's seat is anyone's to take, so
   * there is nothing in the bell to accept from.
   */
  armJoin: (join: PendingJoin) => void
  /** Ask PrivateWagerHost to open an OPEN room (community challenge). */
  armHost: (host: PendingHost) => void
  pendingHost: PendingHost | null
  clearPendingHost: () => void
  /** Forget the card. The server lets the invite lapse on its own timer. */
  declineInvite: (roomId: string) => void
  /** The room is gone (host left / expired) — pull any card for it. */
  removeInvite: (roomId: string) => void

  pendingJoin: PendingJoin | null
  clearPendingJoin: () => void

  /** Mid-match suppression. Driven by App from `gameInSession`. */
  inGame: boolean
  setInGame: (inGame: boolean) => void
}

const NotificationsContext = createContext<NotificationsApi | null>(null)

/**
 * How often expired invites are swept out of the feed. Coarse on purpose:
 * this provider wraps the whole app, so a fast tick would be a whole-app
 * re-render on a timer. `pruneDead` returns the same array when there is
 * nothing to do, so a quiet sweep costs one comparison and re-renders nothing.
 */
const PRUNE_INTERVAL_MS = 20_000

/** How many declined roomIds to remember. Oldest is dropped past this. */
const MAX_DECLINED_ROOMS = 64

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NotificationItem[]>([])
  const [toasts, setToasts] = useState<NotificationItem[]>([])
  const [prefs, setPrefs] = useState<NotificationPrefs>(loadPrefs)
  const [pendingJoin, setPendingJoin] = useState<PendingJoin | null>(null)
  const [pendingHost, setPendingHost] = useState<PendingHost | null>(null)
  const [inGame, setInGameState] = useState(false)

  /**
   * Pop-ups that arrived while a match was running (plus any that were on
   * screen when it started). Replayed on the way out. A ref, not state:
   * nothing renders it, and it must be readable from a stable callback.
   */
  const queuedRef = useRef<NotificationItem[]>([])

  /**
   * Rooms this session has said "Later" to.
   *
   * `private:decline` tells the server, but it can lose a race it has no way
   * to win: decline while the socket is down and the emit sits in socket.io's
   * send buffer, which is flushed on connect — AFTER the server has already
   * run its connection handler and replayed every live invite. The card would
   * come straight back, and by the time the decline landed the server would
   * have deleted the invite, leaving a JOIN button that can only fail.
   *
   * So the client remembers too. Bounded, because a session should not grow a
   * set forever, and by the time it wraps the roomIds in it are long dead.
   */
  const declinedRef = useRef<Set<string>>(new Set())

  // Mirrors so the stable callbacks below never need the values as deps
  // (re-creating `push` on every notification would re-subscribe the socket
  // bridge on every notification).
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const inGameRef = useRef(inGame)
  inGameRef.current = inGame
  const itemsRef = useRef(items)
  itemsRef.current = items
  /** Committed toasts, for the in-game pull below (which runs post-commit). */
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts

  // ── push ────────────────────────────────────────────────────────────────
  const push = useCallback((input: NotificationInput) => {
    // Already declined this room — the server may still replay it (see
    // `declinedRef`), but "Later" means later.
    if (input.invite && declinedRef.current.has(input.invite.roomId)) return

    const now = Date.now()
    const item: NotificationItem = {
      // Default fold key: one row per (kind, person). Invites override it
      // with the roomId, so two invites from the same friend are two rows.
      id: input.id ?? `${input.kind}:${input.from.toLowerCase()}`,
      kind: input.kind,
      from: input.from,
      body: input.body,
      invite: input.invite,
      createdAt: now,
      read: false,
      count: 1,
    }

    // REPLAY, NOT NEWS. The server re-announces every live invite to a fresh
    // socket, so a reconnect (or a reload) re-delivers invitations we already
    // have. They belong in the feed — where they simply overwrite their own
    // row — but popping them up again would nag on every flaky connection.
    const isReplay =
      item.invite !== undefined &&
      itemsRef.current.some((existing) => existing.id === item.id)

    // The FEED always gets it — pop-up prefs are about pop-ups, not about
    // whether you are told at all.
    setItems((prev) => mergeItem(prev, item))
    if (isReplay) return

    const current = prefsRef.current
    if (!current.popups || !current[prefKeyForKind(item.kind)]) return

    if (inGameRef.current) {
      // Mid-match: park it. Replayed by the `inGame` effect below.
      queuedRef.current = dedupeById([item, ...queuedRef.current])
      return
    }
    setToasts((prev) => mergeItem(prev, item))
  }, [])

  // ── in-game suppression: pull on the way in, replay on the way out ──────
  useEffect(() => {
    if (inGame) {
      // A match just started. Anything on screen is now in the way — move it
      // to the queue rather than dropping it.
      if (toastsRef.current.length > 0) {
        queuedRef.current = dedupeById([
          ...toastsRef.current,
          ...queuedRef.current,
        ])
        setToasts([])
      }
      return
    }

    // The match ended. Replay what was held, minus invites the server has
    // already let lapse — offering a JOIN that can only fail is worse than
    // saying nothing.
    if (queuedRef.current.length === 0) return
    const live = pruneDead(queuedRef.current, Date.now())
    queuedRef.current = []
    if (live.length === 0) return
    setToasts((prev) => dedupeById([...live, ...prev]))
  }, [inGame])

  // ── sweep expired invites out of the feed ───────────────────────────────
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now()
      setItems((prev) => pruneDead(prev, now))
      setToasts((prev) => pruneDead(prev, now))
    }, PRUNE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [])

  // ── actions ─────────────────────────────────────────────────────────────
  const setPref = useCallback((key: keyof NotificationPrefs, value: boolean) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value }
      savePrefs(next)
      return next
    })
    // Turning a switch OFF should silence what is ALREADY on screen, not just
    // what comes next — otherwise the toggle looks broken for 20 seconds. The
    // mid-match queue is emptied by the same rule: turning pop-ups off during
    // a game must not produce a burst of them the moment it ends.
    if (value) return
    const silenced = (item: NotificationItem) =>
      key !== 'popups' && prefKeyForKind(item.kind) !== key
    setToasts((prev) => (prev.length === 0 ? prev : prev.filter(silenced)))
    queuedRef.current = queuedRef.current.filter(silenced)
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const markAllRead = useCallback(() => {
    setItems((prev) =>
      prev.some((item) => !item.read)
        ? prev.map((item) => (item.read ? item : { ...item, read: true }))
        : prev
    )
  }, [])

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
    setToasts((prev) => prev.filter((item) => item.id !== id))
    queuedRef.current = queuedRef.current.filter((item) => item.id !== id)
  }, [])

  const clearAll = useCallback(() => {
    setItems([])
    setToasts([])
    queuedRef.current = []
    declinedRef.current.clear()
    setPendingJoin(null)
  }, [])

  const removeInvite = useCallback((roomId: string) => {
    const matches = (item: NotificationItem) => item.invite?.roomId !== roomId
    setItems((prev) => prev.filter(matches))
    setToasts((prev) => prev.filter(matches))
    queuedRef.current = queuedRef.current.filter(matches)
  }, [])

  const acceptInvite = useCallback(
    (roomId: string) => {
      const item = itemsRef.current.find(
        (entry) => entry.invite?.roomId === roomId
      )
      // Gone or lapsed: retire the card instead of opening a room that the
      // server will refuse with `not_invited`.
      if (!item?.invite || item.invite.expiresAt <= Date.now()) {
        removeInvite(roomId)
        return
      }
      // NOTE the card is NOT removed here. Whoever consumes `pendingJoin`
      // (PrivateWagerHost) may refuse — you cannot abandon a live match to
      // take an invite, and a phone cannot open a keyboard-only game — and a
      // refused JOIN that had already deleted its own card would leave the
      // player with nothing to try again with. The host retires it on success.
      setPendingJoin({ ...item.invite, fromUsername: item.from })
    },
    [removeInvite]
  )

  /** Community challenges: nothing to look up or retire — arm it as-is. */
  const armJoin = useCallback((join: PendingJoin) => setPendingJoin(join), [])

  const armHost = useCallback((host: PendingHost) => setPendingHost(host), [])
  const clearPendingHost = useCallback(() => setPendingHost(null), [])

  /**
   * "Later". This used to be a purely client-side forget, which was fine when
   * nothing ever re-announced an invite. It is not fine now that the server
   * REPLAYS every live invite to a fresh socket: without telling the server,
   * the next reconnect hands the card straight back and a dismissed invite
   * keeps re-asking for the rest of its five minutes.
   *
   * The emit is best-effort — the card goes away either way, and a decline the
   * server never hears is no worse than the old behaviour.
   */
  const declineInvite = useCallback(
    (roomId: string) => {
      // Remember locally FIRST — see `declinedRef` for the race this loses
      // otherwise. Capped so a long session can't grow this without bound.
      if (declinedRef.current.size >= MAX_DECLINED_ROOMS) {
        declinedRef.current.delete(declinedRef.current.values().next().value as string)
      }
      declinedRef.current.add(roomId)
      removeInvite(roomId)
      try {
        // Not gated on `connected`: socket.io buffers and flushes on
        // reconnect, which is precisely the case that matters — a decline made
        // during a blip must still land, or the reconnect replays the card.
        getSocket().emit('private:decline', { roomId })
      } catch (err) {
        console.error('[notifications] decline failed:', err)
      }
    },
    [removeInvite]
  )

  const clearPendingJoin = useCallback(() => setPendingJoin(null), [])

  const setInGame = useCallback((next: boolean) => setInGameState(next), [])

  // ── derived ─────────────────────────────────────────────────────────────
  /**
   * `Date.now()` at render is deliberate: the sweep above bounds how stale
   * this can get, and reading the clock here means a lapsed invite stops
   * counting toward the badge on the very next render rather than up to 20s
   * later.
   */
  const live = useMemo(() => pruneDead(items, Date.now()), [items])
  const invites = useMemo(
    () => live.filter((item) => item.invite !== undefined),
    [live]
  )
  const unread = useMemo(
    () => live.reduce((total, item) => total + (item.read ? 0 : 1), 0),
    [live]
  )

  const inviteFrom = useCallback(
    (username: string): NotificationItem | null => {
      const key = username.toLowerCase()
      return (
        invites.find((item) => item.from.toLowerCase() === key) ?? null
      )
    },
    [invites]
  )

  const value = useMemo<NotificationsApi>(
    () => ({
      items: live,
      invites,
      unread,
      prefs,
      setPref,
      toasts,
      dismissToast,
      push,
      markAllRead,
      dismiss,
      clearAll,
      inviteFrom,
      acceptInvite,
      armJoin,
      armHost,
      pendingHost,
      clearPendingHost,
      declineInvite,
      removeInvite,
      pendingJoin,
      clearPendingJoin,
      inGame,
      setInGame,
    }),
    [
      live,
      invites,
      unread,
      prefs,
      setPref,
      toasts,
      dismissToast,
      push,
      markAllRead,
      dismiss,
      clearAll,
      inviteFrom,
      acceptInvite,
      armJoin,
      armHost,
      pendingHost,
      clearPendingHost,
      declineInvite,
      removeInvite,
      pendingJoin,
      clearPendingJoin,
      inGame,
      setInGame,
    ]
  )

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  )
}

/**
 * THE read hook. Throws when used outside the provider, which is a wiring bug
 * rather than a runtime condition — main.tsx mounts the provider above <App/>.
 */
export function useNotifications(): NotificationsApi {
  const api = useContext(NotificationsContext)
  if (!api) {
    throw new Error('useNotifications must be used inside <NotificationsProvider>')
  }
  return api
}
