/**
 * ONLINE QUEUE + ROSTER HANDOFF for the iframe games
 * ==================================================
 * Shared client half of `apps/server/src/socket/games/lobbyGames.ts`, used by
 * Neon Golf Clash, Neon Clumsy and Neon Pug Shooter — the three self-contained
 * <iframe> games that had no online mode at all.
 *
 * BE CLEAR ABOUT WHAT THIS DOES: it queues the player against REAL people and
 * hands the matched roster to the game. It does NOT synchronise the in-iframe
 * simulation — after boot, each player's round still runs locally against the
 * game's own bots. The handoff below is the seam that in-iframe networking will
 * plug into; nothing here pretends the round is synced.
 *
 * THE ONE RULE (verified root cause of "online refuses to search"): the
 * searching state is set OPTIMISTICALLY on click. It never waits for a server
 * echo, so a dropped/absent ack can never freeze the UI on the lobby.
 *
 * NO MONEY: queueing is free — no wager prompt, no stake, no pot.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { connectGameSocket, getSocket } from '../../hooks/useGameSocket';

// ---------------------------------------------------------------------------
// Wire types — mirror socket/games/lobbyGames.ts
// ---------------------------------------------------------------------------

export type LobbyGameId = 'golf' | 'clumsy' | 'pugshooter';

/** One matched player. `you` marks this client's own row. */
export interface OnlineRosterPlayer {
  id: string;
  name: string;
  you: boolean;
}

/** What `lobbyGame:start` delivers — the match this client just got into. */
export interface OnlineMatch {
  game: LobbyGameId;
  mode: string;
  matchId: string;
  room: string;
  players: OnlineRosterPlayer[];
}

/** Same key `useGameSocket` stores the backend JWT under. */
const AUTH_TOKEN_KEY = 'token';

/**
 * localStorage entry the booting iframe can read to learn who it was matched
 * with. localStorage is already the established same-origin channel between
 * the arcade and these games (Pug Shooter's options ride the same mechanism),
 * and it works for Golf/Clumsy too, whose iframe URLs take no parameters.
 */
export const ONLINE_MATCH_STORAGE_KEY = 'neon_arcade_online_match';

/** postMessage protocol: iframe asks, host answers (see useOnlineMatchBridge). */
export const ROSTER_REQUEST_MESSAGE = 'neon-arcade:request-roster';
export const ROSTER_MESSAGE = 'neon-arcade:match-roster';

/** Exactly what lands in localStorage / the postMessage reply. */
export interface OnlineMatchHandoff {
  type: typeof ROSTER_MESSAGE;
  game: LobbyGameId;
  mode: string;
  matchId: string;
  room: string;
  players: OnlineRosterPlayer[];
  startedAt: number;
}

// ---------------------------------------------------------------------------
// useOnlineLobbyQueue — click → searching → matched
// ---------------------------------------------------------------------------

export interface OnlineLobbyQueue {
  /** True from the instant the player clicks — never gated on a server reply. */
  searching: boolean;
  /** Live count from `queue:status` (at least 1 = this client). */
  playersInQueue: number;
  /** Players this mode needs; 0 until the server says otherwise. */
  playersNeeded: number;
  /** Set when matchmaking was refused (no account / socket rejected). */
  error: string | null;
  /** Enter the queue for `mode` (server picks the real player count). */
  findMatch: (mode?: string) => void;
  /** Cancel: leaves the queue and drops the searching screen. */
  cancel: () => void;
  /** Tell the server we walked away from a started match. */
  leaveMatch: (matchId?: string) => void;
  /** FFA early-start vote state (fill-first queues; see SearchingForMatch). */
  voteOpen: boolean;
  votes: number;
  votesNeeded: number;
  /** Cast this player's early-start vote. */
  voteStart: () => void;
}

/**
 * Queue for one iframe game. `onMatched` fires once per match, on the
 * `lobbyGame:start` broadcast; the caller decides what to boot.
 */
export function useOnlineLobbyQueue(
  game: LobbyGameId,
  onMatched: (match: OnlineMatch) => void
): OnlineLobbyQueue {
  const [searching, setSearching] = useState(false);
  const [vote, setVote] = useState({ open: false, votes: 0, needed: 0 });
  const [playersInQueue, setPlayersInQueue] = useState(1);
  const [playersNeeded, setPlayersNeeded] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Refs so the socket listeners can stay registered once per game without
  // re-subscribing on every render/state change.
  const searchingRef = useRef(false);
  const modeRef = useRef<string | undefined>(undefined);
  const onMatchedRef = useRef(onMatched);
  onMatchedRef.current = onMatched;

  // Ordering guard: a cancel's `inQueue:false` can land AFTER a fresh join's
  // `inQueue:true` if the player re-queues immediately. Comparing the two
  // timestamps keeps that stale "false" from killing the new search.
  const lastFindAt = useRef(0);
  const lastLeaveAt = useRef(0);

  const stopSearching = useCallback(() => {
    searchingRef.current = false;
    setSearching(false);
  }, []);

  /** Emit the join for the current mode (also used to re-queue on reconnect). */
  const emitFind = useCallback(() => {
    lastFindAt.current = Date.now();
    const socket = connectGameSocket();
    socket.emit('lobbyGame:find', { game, mode: modeRef.current });
  }, [game]);

  const findMatch = useCallback(
    (mode?: string) => {
      modeRef.current = mode;
      setError(null);
      setPlayersInQueue(1);
      setPlayersNeeded(0);

      // Online play needs the backend JWT; without it the socket would never
      // connect and the player would spin forever on a screen that can't win.
      if (!localStorage.getItem(AUTH_TOKEN_KEY)) {
        setError('Sign in and finish account setup to play online');
        stopSearching();
        return;
      }

      // OPTIMISTIC: the searching screen is up before anything hits the wire.
      searchingRef.current = true;
      setSearching(true);
      emitFind();
    },
    [emitFind, stopSearching]
  );

  const cancel = useCallback(() => {
    stopSearching();
    lastLeaveAt.current = Date.now();
    const socket = getSocket();
    if (socket.connected) socket.emit('lobbyGame:leave', { game });
  }, [game, stopSearching]);

  const leaveMatch = useCallback((matchId?: string) => {
    const socket = getSocket();
    if (socket.connected) socket.emit('lobbyGame:leaveMatch', { matchId });
  }, []);

  /** One early-start YES vote; the server ignores it unless the window is
   *  open and we are genuinely queued (see queue.ts registerQueueVotes). */
  const voteStart = useCallback(() => {
    const socket = getSocket();
    if (socket.connected) {
      socket.emit('queue:voteStart', { game, mode: modeRef.current });
    }
  }, [game]);

  useEffect(() => {
    const socket = getSocket();

    const onQueueStatus = (data: {
      game?: string;
      inQueue?: boolean;
      current?: number;
      needed?: number;
      voteOpen?: boolean;
      votes?: number;
      votesNeeded?: number;
    }) => {
      if (data?.game !== game) return; // another game's queue — ignore
      if (data.inQueue) {
        setPlayersInQueue(Math.max(1, data.current ?? 1));
        setPlayersNeeded(data.needed ?? 0);
        setVote({
          open: data.voteOpen === true,
          votes: data.votes ?? 0,
          needed: data.votesNeeded ?? 0,
        });
        return;
      }
      setVote({ open: false, votes: 0, needed: 0 });
      // Not queued. Ignore if we've re-joined since the leave that caused it
      // (see lastFindAt/lastLeaveAt above); otherwise the server dropped our
      // slot (cancel elsewhere, another session displaced us) — stop spinning.
      if (lastFindAt.current > lastLeaveAt.current) return;
      stopSearching();
    };

    const onStart = (data: OnlineMatch & { game?: string }) => {
      if (data?.game !== game || !Array.isArray(data?.players)) return;
      stopSearching();
      onMatchedRef.current({
        game,
        mode: data.mode,
        matchId: data.matchId,
        room: data.room,
        players: data.players,
      });
    };

    const onAuthError = (data: { code?: string; message?: string }) => {
      if (!searchingRef.current) return;
      stopSearching();
      setError(data?.message ?? 'Online play is unavailable right now');
    };

    const onConnectError = () => {
      if (!searchingRef.current) return;
      stopSearching();
      setError('Could not reach the arcade servers');
    };

    // A reconnect gets a NEW socket id, so the server-side queue slot is gone
    // with the old one — re-queue instead of waiting on a dead entry.
    const onConnect = () => {
      if (searchingRef.current) emitFind();
    };

    socket.on('queue:status', onQueueStatus);
    socket.on('lobbyGame:start', onStart);
    socket.on('gameAuthError', onAuthError);
    socket.on('connect_error', onConnectError);
    socket.on('connect', onConnect);

    return () => {
      socket.off('queue:status', onQueueStatus);
      socket.off('lobbyGame:start', onStart);
      socket.off('gameAuthError', onAuthError);
      socket.off('connect_error', onConnectError);
      socket.off('connect', onConnect);
      // Unmount / view change: never leave a slot behind in the queue.
      if (searchingRef.current) {
        searchingRef.current = false;
        if (socket.connected) socket.emit('lobbyGame:leave', { game });
      }
    };
  }, [game, emitFind, stopSearching]);

  return {
    searching,
    playersInQueue,
    playersNeeded,
    error,
    findMatch,
    cancel,
    leaveMatch,
    voteOpen: vote.open,
    votes: vote.votes,
    votesNeeded: vote.needed,
    voteStart,
  };
}

// ---------------------------------------------------------------------------
// useOnlineMatchBridge — hand the roster to the booting iframe
// ---------------------------------------------------------------------------

/**
 * While an online match is mounted, publish its roster to the game in the two
 * ways a same-origin iframe can pick it up:
 *
 *   1. `localStorage[ONLINE_MATCH_STORAGE_KEY]` — readable synchronously at
 *      boot, which is what these games need (Golf/Clumsy take no URL params).
 *   2. postMessage: the iframe posts `{ type: 'neon-arcade:request-roster' }`
 *      to its parent and gets `{ type: 'neon-arcade:match-roster', … }` back.
 *
 * Both are cleared when the match view unmounts, so a later PRACTICE round can
 * never read a stale roster and think it is online.
 *
 * The in-iframe side of this is not written yet — see the report. Publishing it
 * costs nothing and is the documented seam for that work.
 */
export function useOnlineMatchBridge(match: OnlineMatch | null): void {
  useEffect(() => {
    if (!match) return;

    const handoff: OnlineMatchHandoff = {
      type: ROSTER_MESSAGE,
      game: match.game,
      mode: match.mode,
      matchId: match.matchId,
      room: match.room,
      players: match.players,
      startedAt: Date.now(),
    };

    try {
      localStorage.setItem(ONLINE_MATCH_STORAGE_KEY, JSON.stringify(handoff));
    } catch {
      /* storage blocked/full — the postMessage path below still works */
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return; // same-origin only
      if ((event.data as { type?: string } | null)?.type !== ROSTER_REQUEST_MESSAGE) return;
      (event.source as Window | null)?.postMessage(handoff, window.location.origin);
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      try {
        localStorage.removeItem(ONLINE_MATCH_STORAGE_KEY);
      } catch {
        /* nothing to clean up */
      }
    };
  }, [match]);
}

/** Opponents (everyone but this client) — handy for roster HUDs. */
export function opponentsOf(match: OnlineMatch | null): OnlineRosterPlayer[] {
  return match ? match.players.filter((p) => !p.you) : [];
}

// ---------------------------------------------------------------------------
// SCORE DUEL — the resolution layer over the roster handoff
// ---------------------------------------------------------------------------

/** What `lobbyGame:end` delivers — the score-duel verdict. */
export interface LobbyDuelEnd {
  game: string;
  matchId: string;
  /** Highest score wins; ties share it. Usernames only. */
  winners: string[];
  scores: Array<{ name: string; score: number; you: boolean }>;
}

/**
 * The client half of the lobby-game score duel (golf / clumsy / pug shooter).
 *
 * Each player's round still runs locally; the game's own end-of-round
 * postMessage carries the score. While a real match is live this hook
 * forwards that score to the server (`lobbyGame:result`, once per match) and
 * surfaces the verdict (`lobbyGame:end`) once every remaining member has
 * reported. ‼️ Scores are client-claimed: the verdict is social — the server
 * settles NO RP from it, and XP stays on the capped session path.
 *
 * `resultMessageType` is the iframe's result postMessage type; `scoreOf`
 * extracts the score from that message's data.
 */
export function useLobbyScoreDuel(
  match: OnlineMatch | null,
  resultMessageType: string,
  scoreOf: (data: Record<string, unknown>) => number
): {
  duelEnd: LobbyDuelEnd | null;
  clearDuelEnd: () => void;
  /** "<name> left" — transient, newest only. */
  playerLeft: string | null;
} {
  const [duelEnd, setDuelEnd] = useState<LobbyDuelEnd | null>(null);
  const [playerLeft, setPlayerLeft] = useState<string | null>(null);
  const reportedFor = useRef<string | null>(null);
  /** A report that couldn't go out (transport blip) — flushed on reconnect. */
  const pendingReport = useRef<{ matchId: string; score: number } | null>(null);
  const matchRef = useRef(match);
  matchRef.current = match;
  const scoreOfRef = useRef(scoreOf);
  scoreOfRef.current = scoreOf;

  // Fresh match = fresh verdict state.
  useEffect(() => {
    setDuelEnd(null);
    setPlayerLeft(null);
    pendingReport.current = null;
  }, [match?.matchId]);

  // The leaver toast is transient, not a permanent HUD fixture.
  useEffect(() => {
    if (!playerLeft) return;
    const id = window.setTimeout(() => setPlayerLeft(null), 8000);
    return () => window.clearTimeout(id);
  }, [playerLeft]);

  useEffect(() => {
    const socket = getSocket();

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if ((event.data as { type?: string })?.type !== resultMessageType) return;
      const m = matchRef.current;
      if (!m || reportedFor.current === m.matchId) return;
      reportedFor.current = m.matchId;
      const raw = scoreOfRef.current((event.data ?? {}) as Record<string, unknown>);
      const score = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      if (socket.connected) {
        socket.emit('lobbyGame:result', { matchId: m.matchId, score });
      } else {
        // A round ends exactly once — a blip at that moment must not
        // swallow the report forever. Flushed on the next connect.
        pendingReport.current = { matchId: m.matchId, score };
      }
    };

    // FORFEIT: the round's own overlay confirmed a leave. The iframe keeps
    // simulating underneath and will still post a result — latch WITHOUT
    // reporting so a forfeited round can never win the verdict.
    const onForfeit = () => {
      const m = matchRef.current;
      if (m) reportedFor.current = m.matchId;
      pendingReport.current = null;
    };

    const onConnect = () => {
      const pending = pendingReport.current;
      if (pending) {
        pendingReport.current = null;
        socket.emit('lobbyGame:result', pending);
      }
    };

    const onEnd = (data: LobbyDuelEnd) => {
      if (!data?.matchId || data.matchId !== matchRef.current?.matchId) return;
      setDuelEnd(data);
    };

    const onLeft = (data: { matchId?: string; name?: string }) => {
      if (!data?.matchId || data.matchId !== matchRef.current?.matchId) return;
      setPlayerLeft(data.name ?? 'A player');
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('neon:duel-forfeit', onForfeit);
    socket.on('lobbyGame:end', onEnd);
    socket.on('lobbyGame:playerLeft', onLeft);
    socket.on('connect', onConnect);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('neon:duel-forfeit', onForfeit);
      socket.off('lobbyGame:end', onEnd);
      socket.off('lobbyGame:playerLeft', onLeft);
      socket.off('connect', onConnect);
    };
  }, [resultMessageType]);

  const clearDuelEnd = useCallback(() => setDuelEnd(null), []);
  return { duelEnd, clearDuelEnd, playerLeft };
}
