/**
 * PRIVATE WAGER — WAITING ROOM
 * ============================
 * The invite-only room that sits between a lobby's "PRIVATE WAGER" card and a
 * NORMAL match against a friend. It owns no game logic whatsoever: when
 * everyone presses READY the server runs the 3-2-1 and then drives each
 * player's usual matchmaking entry point, so every game's existing in-match
 * code, ELO settlement and stats recording run completely unchanged.
 *
 * WIRE CONTRACT — apps/server/src/socket/games/privateMatch.ts
 * -----------------------------------------------------------
 *   C→S  private:create { gameKey, mode }
 *   C→S  private:invite { roomId, username }     — accepted friends only
 *   C→S  private:join   { roomId }               — validated against invites
 *   C→S  private:ready  { roomId, ready }
 *   C→S  private:leave  { roomId }               — host leaving closes it
 *   S→C  private:room      { roomId, gameKey, mode, capacity, status,
 *                            host:{username}, players:[{username, ready, isHost}] }
 *   S→C  private:countdown { seconds }
 *   S→C  private:started   { roomId, gameKey, mode }  — the game's OWN start
 *                            event (gameStart / volleyGameStart / …) lands in
 *                            the same tick
 *   S→C  private:closed    { roomId, reason }
 *   S→C  private:error     { code, message }
 *
 * LAYOUT (exactly as the owner described it)
 * ------------------------------------------
 * - 1v1 (capacity 2): a diagonal line across the middle, YOUR profile at the
 *   BOTTOM, and at the TOP a "John Doe" placeholder silhouette reading
 *   "WAITING FOR PLAYER" until someone joins — then their profile.
 * - Non-1v1 (capacity > 2): only the players actually present are shown (no
 *   placeholder seats) and starting with just 2 is allowed, which is also the
 *   server's rule (MIN_PLAYERS = 2).
 *
 * ‼️ SECURITY: every payload above carries USERNAMES ONLY. No wallet, id or
 * email is ever rendered, stored or sent from this file; the local player's
 * identity comes from the JWT the socket/API already hold, never from a prop.
 *
 * NO MONEY: "Private Wager" is a NAME. Nothing here stakes SOL or Neon Bucks.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crown, Link2, LoaderCircle, LogOut, UserPlus, X } from 'lucide-react';
import { getRankInfo } from '@neon/types';
import { profileApi, rankRpOf } from '../../lib/api';
import { connectGameSocket, getSocket } from '../../hooks/useGameSocket';
import PrivateWagerInvite, {
  OnlineFriendPicker,
  PrivateWagerModal,
  announcePrivateWagerStarted,
  privateWagerCapacity,
  privateWagerMinPlayers,
  privateWagerGameTitle,
  privateWagerModeLabel,
  usePrivateWagerInviteRequests,
  type PrivateGameKey,
} from './PrivateWagerInvite';
// Incoming invites live in the app-wide notification store now — the nav-bar
// bell, the sidebar's JOIN button and the in-app pop-ups all offer ACCEPT, and
// all three funnel through `pendingJoin`, which this host consumes.
import { useNotifications } from '../../notifications/NotificationsStore';
import { EntryPotSlider, ENTRY_POT_MIN_USD } from '../common/EntryPotSlider';

// ---------------------------------------------------------------------------
// Wire shapes (mirror the server payload builders)
// ---------------------------------------------------------------------------

export interface PrivateRoomPlayer {
  username: string;
  ready: boolean;
  isHost: boolean;
}

export interface PrivateRoomState {
  roomId: string;
  gameKey: PrivateGameKey;
  mode: string;
  capacity: number;
  status: 'open' | 'starting' | 'closed';
  host: { username: string };
  players: PrivateRoomPlayer[];
}

export interface PrivateWagerRoomProps {
  gameKey: PrivateGameKey;
  mode: string;
  /**
   * JOIN an existing room (accepting an invite) instead of creating one.
   * When set, the friend picker is skipped entirely.
   */
  joinRoomId?: string | null;
  /**
   * Invite this friend the moment the room exists (sidebar entry point).
   * When set, the friend picker is skipped.
   */
  inviteUsername?: string | null;
  /** Close the room UI and go back to the lobby. */
  onClose: () => void;
  /**
   * COMMUNITY CHALLENGE room: `private:create` is sent with `open: true`, so
   * ANY signed-in player who gets the roomId from the community board may
   * take the seat — no invite required. Ordinary rooms stay invite-only.
   */
  open?: boolean;
  /**
   * Fired ONCE with the server-assigned roomId, the first time the room
   * exists. The community board's "post a challenge" flow publishes the
   * roomId from here; everyone else ignores it.
   */
  onRoomCreated?: (roomId: string) => void;
  /**
   * The server started the match (`private:started`).
   *
   * Most lobbies pass NOTHING: their parent screen keeps the game's start
   * listener mounted at all times (ChessGame's `gameStart`, VolleyGame's
   * `volleyGameStart`, the iframe games' `useOnlineLobbyQueue`), so the match
   * takes over on its own and this component simply unmounts.
   *
   * The lobbies whose parent only mounts the online screen on demand — Neon
   * Connect, Neon Quiz, Neon Cells, Neon Asteroids — pass their normal online
   * entry point here so the game screen is mounted and listening. See the
   * per-lobby comment where it is wired.
   */
  onStarted?: () => void;
}

/** Countdown fallback if the server ever omits `seconds`. */
const DEFAULT_COUNTDOWN = 3;

/**
 * `private:error` codes that mean THIS ROOM WILL NEVER OPEN, as opposed to
 * "that one action failed". They matter because this overlay is a full-screen
 * `fixed inset-0` with no backdrop and no Esc: with a room on screen the Leave
 * button is the way out, but before the first `private:room` lands there is no
 * exit at all, and the player is stranded on a spinner until they reload.
 *
 * Easy to hit now that JOIN is offered from the nav-bar bell, an in-app pop-up
 * and a friend's row — any of which can be clicked a moment after the room
 * closed. (Server codes: apps/server/src/socket/games/privateMatch.ts.)
 */
const FATAL_OPEN_CODES = new Set([
  'not_found',
  'not_invited',
  'already_started',
  'room_full',
  'bad_mode',
  'bad_payload',
  'no_account',
  'rate_limited',
]);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PrivateWagerRoom({
  gameKey,
  mode,
  joinRoomId = null,
  inviteUsername = null,
  onClose,
  onStarted,
  open = false,
  onRoomCreated,
}: PrivateWagerRoomProps) {
  /**
   * 'picking' — entry A: choose which ONLINE friend to invite, THEN the room.
   * 'room'    — the waiting room proper.
   */
  // An OPEN (community-challenge) room skips the friend picker too: there is
  // nobody to invite — the seat belongs to whoever takes it from the board.
  const [phase, setPhase] = useState<'picking' | 'room'>(
    joinRoomId || inviteUsername || open ? 'room' : 'picking'
  );
  const [room, setRoom] = useState<PrivateRoomState | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  /** Set when the room never opened at all — see FATAL_OPEN_CODES. */
  const [openFailed, setOpenFailed] = useState<string | null>(null);
  const [showInvitePicker, setShowInvitePicker] = useState(false);
  // The host's chosen entry pot, in whole USD ($5 steps — EntryPotSlider).
  const [entryPotUsd, setEntryPotUsd] = useState(ENTRY_POT_MIN_USD);
  /** Usernames we have asked the server to invite (greys them in the picker). */
  const [invited, setInvited] = useState<string[]>([]);

  /**
   * My own username. Read from MY profile (the JWT identifies me server-side)
   * — never from a payload, and never derived from a wallet.
   */
  // `rp` is the Ranked 2.0 ladder number; `elo` is the legacy mirror kept so
  // `rankRpOf` has something to fall back on. Both are read through
  // `rankRpOf`, never directly.
  const [me, setMe] = useState<{ username: string; rp?: number; elo: number } | null>(null);

  // Refs the socket effect and the unmount cleanup read without re-subscribing.
  const roomIdRef = useRef<string | null>(joinRoomId);
  // Ref so a parent re-render with a new inline callback cannot re-run the
  // socket effect (which would leave and recreate the room).
  const onRoomCreatedRef = useRef(onRoomCreated);
  onRoomCreatedRef.current = onRoomCreated;
  // One-way latch: after OUR room closes, this instance never adopts another
  // (private:closed nulls roomIdRef, which would otherwise re-open adoption).
  const adoptionClosedRef = useRef(false);
  /** Has a `private:room` ever landed here? Decides whether an error is fatal. */
  const hasRoomRef = useRef(false);
  const startedRef = useRef(false);
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /** Invite to send as soon as we own a room (entry A pick / sidebar entry). */
  const pendingInviteRef = useRef<string | null>(inviteUsername);

  const capacity = room?.capacity ?? privateWagerCapacity(gameKey, mode);
  const isDuel = capacity === 2;
  const gameTitle = privateWagerGameTitle(gameKey);
  const modeLabel = privateWagerModeLabel(gameKey, mode);

  // ── my profile (username + RP for the rank pill) ─────────────────────────
  useEffect(() => {
    let alive = true;
    profileApi
      .me()
      .then((profile) => {
        if (alive && profile.username) {
          setMe({ username: profile.username, rp: profile.rp, elo: profile.elo ?? 0 });
        }
      })
      .catch(() => {
        // Non-fatal: the seats still render, we just fall back to matching the
        // local player by host/non-host below.
      });
    return () => {
      alive = false;
    };
  }, []);

  // ── socket: listeners + create/join ──────────────────────────────────────
  useEffect(() => {
    if (phase !== 'room') return;

    const socket = connectGameSocket();

    const onRoom = (data: PrivateRoomState) => {
      if (!data?.roomId) return;
      // The socket is shared with every game; ignore rooms that aren't ours.
      if (roomIdRef.current && data.roomId !== roomIdRef.current) return;
      if (roomIdRef.current === null) {
        // ADOPTION. We created a room and are waiting for its first
        // broadcast — but the singleton socket also carries broadcasts for
        // OTHER rooms this player is in (a lobby's waiting room can still be
        // mounted under the drawer). Never adopt a room for a different
        // game/mode, and never adopt again after our room closed: without
        // these guards a stray broadcast could be mistaken for our create
        // ack, and onRoomCreated would publish a foreign roomId.
        if (adoptionClosedRef.current) return;
        if (data.gameKey !== gameKey || data.mode !== mode) return;
      }
      const isFirst = roomIdRef.current === null;
      roomIdRef.current = data.roomId;
      hasRoomRef.current = true;
      // First sight of OUR room = it now exists on the server. Only meaningful
      // for rooms this component created (a joiner seeded roomIdRef already).
      if (isFirst) onRoomCreatedRef.current?.(data.roomId);
      setRoom(data);
      setError(null);
      setOpenFailed(null);
      // A fresh room supersedes any earlier "room closed" notice. (React's
      // StrictMode double-mount really does create-then-replace a room in dev,
      // and the replaced one broadcasts private:closed.)
      setClosedReason(null);

      // A ready flag going back down (someone joined / left) aborts the
      // countdown server-side, so drop our local ticker too.
      if (data.status !== 'starting') setCountdown(null);

      // Fire the queued invite exactly once, now that a roomId exists.
      const pending = pendingInviteRef.current;
      if (pending) {
        pendingInviteRef.current = null;
        socket.emit('private:invite', { roomId: data.roomId, username: pending });
        setInvited((prev) => (prev.includes(pending) ? prev : [...prev, pending]));
      }
    };

    const onCountdown = (data: { seconds?: number }) => {
      setCountdown(Math.max(1, Math.round(data?.seconds ?? DEFAULT_COUNTDOWN)));
    };

    const onStartedEvent = (data: { roomId?: string }) => {
      // Ours only — the socket is shared with every other private room event.
      if (!roomIdRef.current || data?.roomId !== roomIdRef.current) return;
      // The room is retired server-side — do NOT emit private:leave on unmount.
      startedRef.current = true;
      roomIdRef.current = null;
      setCountdown(null);
      // Hand off first (mounts the game screen for the lobbies that need it),
      // then close this overlay.
      onStartedRef.current?.();
      onCloseRef.current();
    };

    const onClosed = (data: { roomId?: string; reason?: string }) => {
      // Ours only. Before the first private:room lands we have no roomId, so a
      // close for anything else (including the room a StrictMode double-mount
      // just superseded) must be ignored rather than assumed to be ours.
      if (!roomIdRef.current || data?.roomId !== roomIdRef.current) return;
      roomIdRef.current = null;
      adoptionClosedRef.current = true; // never adopt a successor room
      setCountdown(null);
      setRoom(null);
      setClosedReason(data?.reason ?? 'closed');
    };

    const onErrorEvent = (data: { code?: string; message?: string; roomId?: string }) => {
      // NOT OURS. The socket is shared by every private-wager surface at once
      // (a lobby's own waiting room and the app-level host can both be live),
      // so a refusal that names a room we are not working on must be ignored —
      // otherwise one component's error lands on another's screen.
      if (data?.roomId && roomIdRef.current && data.roomId !== roomIdRef.current) {
        return;
      }
      setError(data?.message ?? 'Something went wrong');
      // A refused invite must not keep the target greyed out in the picker.
      if (data?.code === 'invite_failed' || data?.code === 'friend_offline') {
        setInvited([]);
      }
      // FATAL BEFORE THE ROOM EVER OPENED. `private:error` carries no roomId,
      // so we can only distinguish "this room will never exist" from "that one
      // action failed" by the code plus the fact that no `private:room` has
      // ever landed here. Only the former earns the dead-end screen with a
      // Back button — anything else stays an inline red line over a live room.
      if (!hasRoomRef.current && data?.code && FATAL_OPEN_CODES.has(data.code)) {
        setOpenFailed(data.message ?? 'That room is not available');
      }
    };

    // The server refuses online play without a finished account.
    const onAuthError = (data: { message?: string }) => {
      setError(data?.message ?? 'Finish account setup to play online');
    };

    socket.on('private:room', onRoom);
    socket.on('private:countdown', onCountdown);
    socket.on('private:started', onStartedEvent);
    socket.on('private:closed', onClosed);
    socket.on('private:error', onErrorEvent);
    socket.on('gameAuthError', onAuthError);

    // Create or join. Emits are buffered by socket.io until the connection is
    // up, so this is safe before `connect` lands.
    if (joinRoomId) {
      socket.emit('private:join', { roomId: joinRoomId });
    } else {
      // `open` marks a community-challenge room (see the prop's doc).
      socket.emit('private:create', { gameKey, mode, ...(open ? { open: true } : {}) });
    }

    return () => {
      socket.off('private:room', onRoom);
      socket.off('private:countdown', onCountdown);
      socket.off('private:started', onStartedEvent);
      socket.off('private:closed', onClosed);
      socket.off('private:error', onErrorEvent);
      socket.off('gameAuthError', onAuthError);
      // Leaving the screen must never strand a room on the server. (A started
      // match already cleared the ref — private:leave would be a no-op there,
      // but not emitting it keeps the intent obvious.)
      const id = roomIdRef.current;
      if (id && !startedRef.current && socket.connected) {
        socket.emit('private:leave', { roomId: id });
      }
    };
    // joinRoomId/gameKey/mode are fixed for the lifetime of this overlay.
  }, [phase, joinRoomId, gameKey, mode]);

  // ── local 3-2-1 ticker (the server owns the real timer) ──────────────────
  useEffect(() => {
    if (countdown === null || countdown <= 0) return;
    const id = window.setTimeout(() => setCountdown((n) => (n === null ? null : n - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [countdown]);

  // ── derived roster ───────────────────────────────────────────────────────
  const players = room?.players ?? [];

  /**
   * Which seat is mine. Primary: my username from /api/profile/me (the JWT
   * identifies me server-side — nothing here is derived from a payload).
   *
   * Fallbacks for when that request failed: I created the room, so I am the
   * host; or I joined a 2-seat room, so I am the one who is NOT the host.
   */
  const myUsername = useMemo(() => {
    if (me?.username) return me.username;
    if (!joinRoomId && room?.host.username) return room.host.username;
    if (joinRoomId && room && room.players.length === 2) {
      return room.players.find((p) => !p.isHost)?.username ?? null;
    }
    return null;
  }, [me, joinRoomId, room]);

  const mySeat = useMemo(
    () => players.find((p) => p.username === myUsername) ?? null,
    [players, myUsername]
  );
  const others = useMemo(
    () => players.filter((p) => p.username !== myUsername),
    [players, myUsername]
  );

  const iAmReady = mySeat?.ready ?? false;
  const iAmHost = mySeat?.isHost ?? (!joinRoomId && room !== null);
  /** 'idle' → 'copied' flash for the invite-link button. */
  const [linkCopied, setLinkCopied] = useState(false);

  /**
   * INVITE LINK (mobile + desktop). One tap: the room is marked
   * link-joinable server-side (host-only `private:allowLink` — the v4
   * roomId in the URL is the capability), then the URL goes out through the
   * native share sheet on phones or the clipboard on desktop. Opening it
   * runs the arcade's normal JOIN path (sign-in gate included) — see the
   * `?wager=` intake in App.tsx.
   */
  const shareInviteLink = useCallback(() => {
    const id = roomIdRef.current;
    if (!id) return;
    const socket = getSocket();
    if (socket.connected) socket.emit('private:allowLink', { roomId: id });
    const url = `${window.location.origin}/?wager=${encodeURIComponent(id)}&g=${encodeURIComponent(gameKey)}&m=${encodeURIComponent(mode)}`;
    const nav = navigator as Navigator & { share?: (d: { url: string; title?: string }) => Promise<void> };
    if (nav.share) {
      void nav.share({ url, title: 'Neon Arcade — join my match' }).catch(() => {});
    } else {
      void navigator.clipboard?.writeText(url).catch(() => {});
    }
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 2000);
  }, [gameKey, mode]);
  // The mode's start floor: 2 everywhere, EXACTLY 4 for pugshooter duo —
  // the server refuses to start a strict team mode half-filled, so the UI
  // must not advertise readiness as start-capable before the floor is met.
  const minPlayers = privateWagerMinPlayers(gameKey, mode);
  const canStart = players.length >= minPlayers;
  const roomFull = players.length >= capacity;

  // ── actions ──────────────────────────────────────────────────────────────
  const toggleReady = useCallback(() => {
    const id = roomIdRef.current;
    if (!id) return;
    getSocket().emit('private:ready', { roomId: id, ready: !iAmReady });
  }, [iAmReady]);

  const invite = useCallback((username: string) => {
    const id = roomIdRef.current;
    setShowInvitePicker(false);
    if (!id) {
      // Room not built yet (entry A: the pick happens before create) — queue it.
      pendingInviteRef.current = username;
      setInvited((prev) => (prev.includes(username) ? prev : [...prev, username]));
      setPhase('room');
      return;
    }
    getSocket().emit('private:invite', { roomId: id, username });
    setInvited((prev) => (prev.includes(username) ? prev : [...prev, username]));
  }, []);

  const leave = useCallback(() => {
    const id = roomIdRef.current;
    if (id && getSocket().connected) {
      getSocket().emit('private:leave', { roomId: id });
    }
    roomIdRef.current = null;
    onCloseRef.current();
  }, []);

  // ── entry A step 1: pick an ONLINE friend, then build the room ───────────
  if (phase === 'picking') {
    return (
      <OnlineFriendPicker
        title={`${gameTitle} · private wager`}
        subtitle={`${modeLabel} · invite an online friend`}
        onPick={invite}
        onCancel={onClose}
      />
    );
  }

  // RANKED 2.0: the badge comes from RP. `rankRpOf` prefers the new `rp`
  // field and falls back to the legacy `elo` mirror, so this is correct both
  // before and after the server starts sending `rp` (it does now).
  const myRp = rankRpOf(me);
  const myRank = myRp !== null ? getRankInfo(myRp).tier : null;

  return (
    <div className="fixed inset-0 z-[110] bg-[#081616] overflow-y-auto overflow-x-hidden">
      {/* Background wash, matching every other neon screen. */}
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className="absolute top-20 left-20 w-96 h-96 bg-[#00FFD1] rounded-full blur-[120px] opacity-20 animate-pulse" />
        <div
          className="absolute bottom-20 right-20 w-96 h-96 bg-[#FF0080] rounded-full blur-[120px] opacity-20 animate-pulse"
          style={{ animationDelay: '1s' }}
        />
      </div>

      <div className="relative z-10 min-h-full flex flex-col items-center justify-center px-6 py-10">
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="text-center mb-8">
          <p className="text-[10px] font-mono tracking-[0.4em] uppercase text-[#00FFD1]/70">
            Private Wager
          </p>
          <h1 className="mt-2 text-4xl md:text-6xl font-black text-[#FFFFFD] drop-shadow-[0_0_20px_rgba(0,255,209,0.6)] uppercase tracking-tighter italic">
            {gameTitle}
          </h1>
          <p className="mt-2 text-[10px] font-mono tracking-[0.3em] uppercase text-[#B1C5FF]/50">
            {modeLabel}
            {!isDuel && ` · ${players.length}/${capacity} players`}
          </p>
        </div>

        {/* ── Seats ────────────────────────────────────────────────────── */}
        {closedReason ? (
          <ClosedNotice reason={closedReason} onClose={onClose} />
        ) : openFailed ? (
          /* THE ROOM NEVER OPENED — see FATAL_OPEN_CODES. Without this branch
             the player sits on the spinner below with no exit at all. */
          <ClosedNotice reason="closed" message={openFailed} onClose={onClose} />
        ) : !room ? (
          <div className="flex items-center gap-3 py-16 font-mono text-[10px] uppercase tracking-[0.3em] text-[#B1C5FF]/50">
            <LoaderCircle className="w-4 h-4 animate-spin" />
            Opening room
          </div>
        ) : isDuel ? (
          <DuelSeats
            opponent={others[0] ?? null}
            you={mySeat}
            youLabel={myUsername ?? 'YOU'}
            youRank={myRank}
          />
        ) : (
          <RosterSeats players={players} myUsername={myUsername} myRank={myRank} />
        )}

        {/* ── Errors (invite refused, room full, rate limited, …) ───────── */}
        {error && !closedReason && !openFailed && (
          <p className="mt-6 text-[10px] font-mono tracking-[0.2em] uppercase text-[#FF6B9A] text-center max-w-md">
            {error}
          </p>
        )}

        {/* ── Controls ─────────────────────────────────────────────────── */}
        {room && !closedReason && (
          <div className="mt-10 flex flex-col items-center gap-4 w-full max-w-md">
            {/* ── Entry pot (on-chain wagering) ──────────────────────────
                Host picks the stake in $5 USD steps; the SOL equivalent is
                what each seat will deposit once the lobby is wired to
                POST /api/deposits (backend live — see
                WAGERING_IMPLEMENTATION.md §4). Until that wiring lands the
                selection is local to this room screen. */}
            {iAmHost && (
              <div className="w-full rounded-2xl border border-[#00FFD1]/20 bg-[#00FFD1]/5 p-4">
                <EntryPotSlider
                  valueUsd={entryPotUsd}
                  onChange={(usd) => setEntryPotUsd(usd)}
                  disabled={room.status === 'starting'}
                />
                <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.25em] text-[#B1C5FF]/40 text-center">
                  Deposits go live with on-chain wagering
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={toggleReady}
              disabled={room.status === 'starting'}
              className={`w-full py-4 rounded-2xl font-black text-lg uppercase tracking-tighter italic transition-all cursor-pointer disabled:cursor-default ${
                iAmReady
                  ? 'bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] shadow-[0_0_40px_rgba(0,255,209,0.4)]'
                  : 'border border-[#00FFD1]/40 text-white hover:border-[#00FFD1] hover:bg-[#00FFD1]/10'
              }`}
            >
              {iAmReady ? 'Ready — waiting for the others' : 'Ready'}
            </button>

            <div className="flex items-center gap-3 w-full">
              <button
                type="button"
                onClick={() => setShowInvitePicker(true)}
                disabled={roomFull || room.status === 'starting'}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-[#00FFD1]/30 font-mono text-[10px] uppercase tracking-[0.25em] text-[#B1C5FF]/70 hover:text-white hover:border-[#00FFD1]/70 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-default"
              >
                <UserPlus className="w-3.5 h-3.5" />
                {roomFull ? 'Room full' : 'Invite friend'}
              </button>
              {iAmHost && (
                <button
                  type="button"
                  onClick={shareInviteLink}
                  disabled={roomFull || room.status === 'starting'}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-[#00FFD1]/30 font-mono text-[10px] uppercase tracking-[0.25em] text-[#B1C5FF]/70 hover:text-white hover:border-[#00FFD1]/70 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-default"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  {linkCopied ? 'Link copied!' : 'Invite link'}
                </button>
              )}
              <button
                type="button"
                onClick={leave}
                className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl border border-[#FF6B9A]/30 font-mono text-[10px] uppercase tracking-[0.25em] text-[#FF6B9A]/80 hover:text-[#FF6B9A] hover:border-[#FF6B9A]/70 transition-all cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                Leave
              </button>
            </div>

            <p className="text-[9px] font-mono tracking-[0.25em] uppercase text-[#B1C5FF]/30 text-center">
              {canStart
                ? 'Everyone ready starts the match'
                : minPlayers > 2
                  ? `Waiting for ${minPlayers} players (${players.length}/${minPlayers})`
                  : 'Waiting for at least one more player'}
              {' · '}
              Private matches are free — no stake
            </p>
          </div>
        )}
      </div>

      {/* ── 3-2-1 ────────────────────────────────────────────────────────── */}
      {countdown !== null && countdown > 0 && <CountdownOverlay value={countdown} />}

      {/* ── Invite picker over the room ──────────────────────────────────── */}
      {showInvitePicker && (
        <OnlineFriendPicker
          title="Invite a friend"
          subtitle={`${gameTitle} · ${modeLabel}`}
          excludeUsernames={[...players.map((p) => p.username), ...invited]}
          onPick={invite}
          onCancel={() => setShowInvitePicker(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1v1 — the diagonal split the owner asked for
// ---------------------------------------------------------------------------

function DuelSeats({
  opponent,
  you,
  youLabel,
  youRank,
}: {
  opponent: PrivateRoomPlayer | null;
  you: PrivateRoomPlayer | null;
  youLabel: string;
  youRank: string | null;
}) {
  return (
    <div className="relative w-full max-w-3xl aspect-[5/4] sm:aspect-[16/9]">
      {/* THE DIAGONAL: bottom-left → top-right, splitting the box into the
          opponent's half (upper left) and yours (lower right). */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="pw-diagonal" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#00FFD1" stopOpacity="0.05" />
            <stop offset="50%" stopColor="#00FFD1" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#FF0080" stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <line
          x1="-5"
          y1="105"
          x2="105"
          y2="-5"
          stroke="url(#pw-diagonal)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          style={{ filter: 'drop-shadow(0 0 6px rgba(0,255,209,0.7))' }}
        />
      </svg>

      {/* TOP seat — the opponent, or the "John Doe" placeholder. */}
      <div className="absolute left-0 top-0 w-[70%] flex justify-start">
        {opponent ? (
          <SeatCard
            username={opponent.username}
            ready={opponent.ready}
            isHost={opponent.isHost}
            isYou={false}
          />
        ) : (
          <WaitingSeat />
        )}
      </div>

      {/* Centre badge sitting on the diagonal. */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="px-4 py-1.5 rounded-full bg-[#041010]/90 border border-[#00FFD1]/40 font-black italic text-sm uppercase tracking-tighter text-[#00FFD1] shadow-[0_0_20px_rgba(0,255,209,0.35)]">
          VS
        </span>
      </div>

      {/* BOTTOM seat — always you. */}
      <div className="absolute right-0 bottom-0 w-[70%] flex justify-end">
        <SeatCard
          username={you?.username ?? youLabel}
          rank={youRank}
          ready={you?.ready ?? false}
          isHost={you?.isHost ?? false}
          isYou
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Non-1v1 — ONLY the players actually present. No placeholder seats.
// ---------------------------------------------------------------------------

function RosterSeats({
  players,
  myUsername,
  myRank,
}: {
  players: PrivateRoomPlayer[];
  myUsername: string | null;
  myRank: string | null;
}) {
  return (
    <div className="w-full max-w-3xl">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {players.map((player) => {
          const isYou = player.username === myUsername;
          return (
            <SeatCard
              key={player.username}
              username={player.username}
              rank={isYou ? myRank : null}
              ready={player.ready}
              isHost={player.isHost}
              isYou={isYou}
            />
          );
        })}
      </div>
      <p className="mt-4 text-center text-[9px] font-mono tracking-[0.25em] uppercase text-[#B1C5FF]/30">
        Only the players in the room are shown · two is enough to start
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seat cards
// ---------------------------------------------------------------------------

function SeatCard({
  username,
  rank = null,
  ready,
  isHost,
  isYou,
}: {
  username: string;
  rank?: string | null;
  ready: boolean;
  isHost: boolean;
  isYou: boolean;
}) {
  return (
    <div
      className={`w-full max-w-sm flex items-center gap-4 p-4 rounded-2xl backdrop-blur-md border transition-all ${
        ready
          ? 'border-[#00FFD1] bg-[#00FFD1]/10 shadow-[0_0_30px_rgba(0,255,209,0.25)]'
          : 'border-[#00FFD1]/25 bg-[#041010]/80'
      }`}
    >
      <span className="relative shrink-0">
        <span className="w-14 h-14 rounded-full bg-gradient-to-br from-[#00FFD1]/50 to-[#0452c4]/50 border border-[#00FFD1]/30 flex items-center justify-center text-xl font-black text-[#081616] uppercase">
          {username.slice(0, 1)}
        </span>
        {isHost && (
          <Crown
            className="absolute -top-1.5 -right-1.5 w-4 h-4 text-[#FFD700] drop-shadow-[0_0_6px_rgba(255,215,0,0.8)]"
            aria-label="Host"
          />
        )}
      </span>

      <div className="flex-1 min-w-0 text-left">
        {/* Usernames are rendered as TEXT — React escapes them. Never HTML. */}
        <p className="text-lg font-black uppercase italic tracking-tighter text-white truncate">
          {username}
        </p>
        <p className="mt-0.5 text-[9px] font-mono uppercase tracking-[0.25em] text-[#B1C5FF]/50">
          {isYou ? 'You' : 'Opponent'}
          {rank ? ` · ${rank}` : ''}
        </p>
      </div>

      <span
        className={`shrink-0 px-3 py-1.5 rounded-full font-mono text-[9px] font-bold uppercase tracking-[0.2em] ${
          ready ? 'bg-[#00FFD1] text-[#081616]' : 'border border-white/15 text-white/35'
        }`}
      >
        {ready ? 'Ready' : 'Not ready'}
      </span>
    </div>
  );
}

/** The empty TOP seat: a "John Doe" silhouette + WAITING FOR PLAYER. */
function WaitingSeat() {
  return (
    <div className="w-full max-w-sm flex items-center gap-4 p-4 rounded-2xl border border-dashed border-[#B1C5FF]/20 bg-[#041010]/50 backdrop-blur-md">
      <span className="w-14 h-14 shrink-0 rounded-full bg-[#0d1c1c] border border-[#B1C5FF]/15 flex items-center justify-center overflow-hidden">
        {/* Classic "no profile picture" bust. */}
        <svg viewBox="0 0 40 40" className="w-10 h-10" aria-hidden="true">
          <circle cx="20" cy="14" r="7" fill="rgba(177,197,255,0.28)" />
          <path
            d="M6 38c0-8 6.5-13 14-13s14 5 14 13z"
            fill="rgba(177,197,255,0.28)"
          />
        </svg>
      </span>
      <div className="flex-1 min-w-0 text-left">
        <p className="text-lg font-black uppercase italic tracking-tighter text-white/30 truncate">
          John Doe
        </p>
        <p className="mt-0.5 text-[9px] font-mono uppercase tracking-[0.25em] text-[#00FFD1]/60 animate-pulse">
          Waiting for player
        </p>
      </div>
      <span className="shrink-0 flex gap-1">
        {[0, 0.2, 0.4].map((delay) => (
          <span
            key={delay}
            className="w-1.5 h-1.5 rounded-full bg-[#00FFD1]/70 animate-bounce"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Countdown + closed notice
// ---------------------------------------------------------------------------

function CountdownOverlay({ value }: { value: number }) {
  return (
    <div className="fixed inset-0 z-[125] flex flex-col items-center justify-center bg-[#020808]/85 backdrop-blur-sm pointer-events-none">
      <p className="font-mono text-[10px] uppercase tracking-[0.5em] text-[#00FFD1]/70">
        Match starting
      </p>
      <span
        key={value}
        className="mt-4 text-[9rem] leading-none font-black italic text-[#FFFFFD] drop-shadow-[0_0_40px_rgba(0,255,209,0.8)]"
        style={{ animation: 'privateWagerPop 800ms ease-out' }}
      >
        {value}
      </span>
      {/* Local keyframes — the arcade has no shared "pop" utility. */}
      <style>{`
        @keyframes privateWagerPop {
          0%   { transform: scale(0.5); opacity: 0; }
          35%  { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

/** Why a room disappeared, phrased for a player. */
const CLOSE_REASONS: Record<string, string> = {
  host_left: 'The host left — the room is closed',
  expired: 'The room expired',
  closed: 'The room is closed',
};

function ClosedNotice({
  reason,
  message,
  onClose,
}: {
  reason: string;
  /** Server-supplied text, used verbatim when we have one (join refusals). */
  message?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-6 py-16 text-center">
      <X className="w-10 h-10 text-[#FF6B9A]" />
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-[#FF6B9A]">
        {message ?? CLOSE_REASONS[reason] ?? CLOSE_REASONS.closed}
      </p>
      <button
        type="button"
        onClick={onClose}
        className="px-10 py-3 rounded-xl border border-[#00FFD1] text-[#00FFD1] font-mono text-xs uppercase tracking-[0.28em] hover:bg-[#00FFD1]/10 transition-all cursor-pointer"
      >
        Back
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// APP-LEVEL HOST — entry B (sidebar) + incoming invites
// ---------------------------------------------------------------------------

/**
 * Mount ONE of these near the root of the app (next to SidebarMenu) and the
 * whole non-lobby half of private wager works:
 *
 *   - the sidebar's hover invite calls `openPrivateWagerInvite(username)`
 *     (exported from PrivateWagerInvite.tsx) → game/mode picker → room, with
 *     that friend invited automatically;
 *   - every ACCEPTED incoming invite opens the same room in join mode.
 *
 * It renders nothing until one of those happens, so it is safe to mount always.
 *
 * WHERE AN ACCEPT COMES FROM
 * --------------------------
 * Not from here any more. An incoming `private:invited` push is owned by the
 * notification store, which offers it in three places — the nav-bar bell, the
 * in-app pop-up, and the JOIN button on that friend's ONLINE FRIENDS row — and
 * all three call `acceptInvite(roomId)`. That sets `pendingJoin`, which this
 * host picks up below and clears. ONE accept path, three buttons.
 *
 * GETTING THE PLAYER TO THE GAME (this is the whole point)
 * --------------------------------------------------------
 * A room opened from a lobby is already standing on that game's screen, so
 * when the server starts the match the game's own start event has a listener
 * waiting. A room opened from the NAV BAR is not: the invitee could be on the
 * landing page. So this host takes `onOpenGame`, which navigates the arcade to
 * the invited game BEFORE the waiting room appears — the game's screen mounts
 * underneath the overlay and is listening long before anyone presses READY.
 *
 * `onOpenGame` returns false when the arcade refuses (a keyboard-only game on
 * a phone), and then no room is opened at all rather than dropping someone
 * into a match they cannot play.
 *
 * `onStarted` then announces the start on the window, for the four lobbies
 * (Connect, Quiz, Cells, Asteroids) that only mount their ONLINE screen on
 * demand — see `usePrivateWagerStarted`.
 */
export interface PrivateWagerHostProps {
  /**
   * Navigate the arcade to this game's screen. Returns a REASON when it
   * refuses (shown to the player) and null when it navigated. Without it the
   * host still works, but only for games whose screen happens to already be
   * mounted.
   */
  onOpenGame?: (gameKey: PrivateGameKey) => string | null
}

export function PrivateWagerHost({ onOpenGame }: PrivateWagerHostProps = {}) {
  const [challenge, setChallenge] = useState<string | null>(null);
  const [session, setSession] = useState<{
    gameKey: PrivateGameKey;
    mode: string;
    joinRoomId?: string;
    inviteUsername?: string;
    /** Community challenge: create the room OPEN and report its roomId. */
    openRoom?: boolean;
    onRoomCreated?: (roomId: string) => void;
    /**
     * Monotonic, and used as the room's React `key`. A JOIN can now arrive
     * while a room is ALREADY open (an invite pop-up sits above the waiting
     * room), which swaps `joinRoomId` on a live component — and
     * `PrivateWagerRoom` keeps its roomId in a ref seeded at mount, so it
     * would go on filtering `private:room` against the room it just left and
     * render nothing. Re-keying remounts it with fresh refs; its cleanup
     * emits `private:leave` for the old room on the way out, which is exactly
     * what leaving one room for another should do.
     */
    seq: number;
  } | null>(null);
  const sessionSeq = useRef(0);

  /** Why a JOIN could not be honoured — shown instead of silently doing nothing. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The community board failed to publish an open room (CommunityPanel's
   *  retries all failed). Shown ON TOP of the waiting room, because the room
   *  is live — the host just isn't advertised anywhere. */
  const [postFailed, setPostFailed] = useState(false);

  useEffect(() => {
    const onFail = () => setPostFailed(true);
    window.addEventListener('neon:challenge-post-failed', onFail);
    return () => window.removeEventListener('neon:challenge-post-failed', onFail);
  }, []);

  const { pendingJoin, clearPendingJoin, removeInvite, pendingHost, clearPendingHost } =
    useNotifications();

  // Read through a ref so the JOIN effect below does not re-run (and re-open a
  // room) just because the parent re-rendered with a new inline callback.
  const onOpenGameRef = useRef(onOpenGame);
  onOpenGameRef.current = onOpenGame;

  usePrivateWagerInviteRequests((username) => {
    setSession(null);
    setChallenge(username);
  });

  // Somebody pressed JOIN — from the nav-bar bell, an in-app pop-up, or a
  // friend's row in the menu. Clearing it immediately is what makes this a
  // one-shot handoff: the store never re-arms an accept we already opened.
  useEffect(() => {
    if (!pendingJoin) return;
    clearPendingJoin();
    setChallenge(null);
    // Navigate FIRST. The game's screen has to be mounted and listening before
    // the match starts, and a refusal — you are mid-match, or it is a
    // keyboard-only game on a phone — must stop us opening a room the player
    // cannot actually play.
    const refused = onOpenGameRef.current?.(pendingJoin.gameKey) ?? null;
    if (refused) {
      // The invite card is deliberately still there (acceptInvite does not
      // retire it), so "finish your match, then join" is a real option.
      setRefusal(refused);
      return;
    }
    // Committed: the card has done its job.
    removeInvite(pendingJoin.roomId);
    sessionSeq.current += 1;
    setSession({
      gameKey: pendingJoin.gameKey,
      mode: pendingJoin.mode,
      joinRoomId: pendingJoin.roomId,
      seq: sessionSeq.current,
    });
  }, [pendingJoin, clearPendingJoin, removeInvite]);

  // Somebody pressed OPEN CHALLENGE on the community board. Same choreography
  // as a JOIN: navigate to the game first (and surface a refusal), then open
  // the waiting room — but this one is created OPEN, and its roomId flows
  // back through onRoomCreated so the panel can publish the challenge post.
  useEffect(() => {
    if (!pendingHost) return;
    clearPendingHost();
    setChallenge(null);
    const refused = onOpenGameRef.current?.(pendingHost.gameKey) ?? null;
    if (refused) {
      setRefusal(refused);
      return;
    }
    sessionSeq.current += 1;
    setSession({
      gameKey: pendingHost.gameKey,
      mode: pendingHost.mode,
      openRoom: true,
      onRoomCreated: pendingHost.onCreated,
      seq: sessionSeq.current,
    });
  }, [pendingHost, clearPendingHost]);

  return (
    <>
      {challenge && !session && (
        <PrivateWagerInvite
          username={challenge}
          onCancel={() => setChallenge(null)}
          onLaunch={({ gameKey, mode }) => {
            // Same rule as the JOIN path: get the arcade onto the game's
            // screen first, and say why if it refuses.
            const refused = onOpenGameRef.current?.(gameKey) ?? null;
            if (refused) {
              setChallenge(null);
              setRefusal(refused);
              return;
            }
            sessionSeq.current += 1;
            setSession({
              gameKey,
              mode,
              inviteUsername: challenge,
              seq: sessionSeq.current,
            });
            setChallenge(null);
          }}
        />
      )}

      {session && (
        <PrivateWagerRoom
          key={session.seq}
          gameKey={session.gameKey}
          mode={session.mode}
          joinRoomId={session.joinRoomId ?? null}
          inviteUsername={session.inviteUsername ?? null}
          open={session.openRoom ?? false}
          onRoomCreated={session.onRoomCreated}
          onClose={() => setSession(null)}
          /* The four lobbies that only mount their ONLINE screen on demand
             hear this and do exactly what they do for a room they opened
             themselves. Harmless for the games that ignore it. */
          onStarted={() =>
            announcePrivateWagerStarted(session.gameKey, session.mode)
          }
        />
      )}

      {postFailed && (
        <PrivateWagerModal
          title="Challenge not posted"
          onCancel={() => setPostFailed(false)}
        >
          <p className="text-sm leading-relaxed text-white/80">
            Your room is open, but posting it to the community board failed.
            Invite a friend directly, or close the room and try again.
          </p>
          <button
            type="button"
            onClick={() => setPostFailed(false)}
            className="mt-5 w-full cursor-pointer rounded-lg border border-[#00FFD1]/40 py-2.5 text-[10px] uppercase tracking-[0.25em] text-[#00FFD1] transition-all hover:bg-[#00FFD1]/10"
          >
            Got it
          </button>
        </PrivateWagerModal>
      )}

      {/* A JOIN we could not honour. Silently doing nothing here was the worst
          of the options: the player pressed a button and the invite appeared
          to evaporate. The card is still in the bell, so this really is
          "not now" rather than "never". */}
      {refusal && !session && (
        <PrivateWagerModal
          title="Can't join right now"
          onCancel={() => setRefusal(null)}
        >
          <p className="text-sm leading-relaxed text-white/80">{refusal}</p>
          <p className="mt-3 text-[10px] uppercase tracking-[0.2em] text-[#B1C5FF]/40">
            The invite is still in your notifications.
          </p>
          <button
            type="button"
            onClick={() => setRefusal(null)}
            className="mt-5 w-full cursor-pointer rounded-lg border border-[#00FFD1]/40 py-2.5 text-[10px] uppercase tracking-[0.25em] text-[#00FFD1] transition-all hover:bg-[#00FFD1]/10"
          >
            Got it
          </button>
        </PrivateWagerModal>
      )}
    </>
  );
}
