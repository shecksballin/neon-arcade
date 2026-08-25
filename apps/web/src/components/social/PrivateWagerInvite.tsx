/**
 * PRIVATE WAGER — INVITE PICKERS
 * ==============================
 * The two "who / what" steps that sit in front of `PrivateWagerRoom`:
 *
 *   ENTRY A (lobby)   PRIVATE WAGER card → <OnlineFriendPicker> → room
 *                     (the game + mode are already known: it is that lobby)
 *   ENTRY B (sidebar) hover a friend → invite → <PrivateWagerInvite> game/mode
 *                     picker → room (the friend is already known)
 *
 * This file is a LEAF on purpose — it never imports PrivateWagerRoom, so the
 * room can import the pickers without an import cycle.
 *
 * ‼️ SECURITY (design contract, SECURITY MODEL)
 * ---------------------------------------------
 * `username` is the ONLY identifier that appears anywhere below. Friends come
 * from `GET /api/social/friends`, which serves usernames + rank + online flag
 * and nothing else; there is no wallet, id or email in any payload this file
 * touches, and none is ever sent. Everything is rendered as TEXT (React escapes
 * by default) — no dangerouslySetInnerHTML anywhere near a username.
 *
 * NO MONEY: "Private Wager" is a NAME. Nothing here stakes SOL or Neon Bucks.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Ban, Check, LoaderCircle, Search, Swords, X } from 'lucide-react';
import { socialApi, type FriendEntry } from '../../lib/api';
import { getSocket } from '../../hooks/useGameSocket';
// The catalog is a leaf module (see the re-export block below) — this file
// needs the values in scope as well as re-exported.
import {
  PRIVATE_WAGER_GAMES,
  privateWagerGame,
  type PrivateGameKey,
} from './privateWagerCatalog';
import CellsDifficultySelector, {
  CELLS_DEFAULT_ONLINE_DIFFICULTY,
  cellsDifficultyToCompositeMode,
  type CellsSectorCopy,
  type CellsSectorId,
} from '../Cells/CellsDifficultySelector';
import AsteroidsDifficultySelector, {
  ASTEROIDS_DEFAULT_ONLINE_DIFFICULTY,
  asteroidsDifficultyToCompositeMode,
  type AsteroidsSectorCopy,
  type AsteroidsSectorId,
} from '../Asteroids/AsteroidsDifficultySelector';

// ---------------------------------------------------------------------------
// CATALOG — now a LEAF MODULE, re-exported here
//
// The table itself moved to ./privateWagerCatalog so the notification centre
// and the sidebar's JOIN button can label an invite without importing this
// file (which static-imports the Cells + Asteroids selectors, ~35 kB of
// game-directory code that has no business in the entry chunk).
//
// Everything is re-exported so existing importers — PrivateWagerRoom and any
// lobby reaching for `privateWagerCapacity` — keep working unchanged.
// ---------------------------------------------------------------------------

export {
  PRIVATE_WAGER_GAMES,
  privateWagerGame,
  privateWagerGameTitle,
  privateWagerModeLabel,
  privateWagerCapacity,
  privateWagerMinPlayers,
  isPrivateGameKey,
} from './privateWagerCatalog';
export type {
  PrivateGameKey,
  PrivateWagerGame,
  PrivateWagerMode,
} from './privateWagerCatalog';

// ---------------------------------------------------------------------------
// Shared modal chrome — one place so every private-wager popup matches
// ---------------------------------------------------------------------------

export function PrivateWagerModal({
  title,
  subtitle,
  onCancel,
  children,
  size = 'md',
}: {
  title: string;
  subtitle?: string;
  onCancel: () => void;
  children: ReactNode;
  /**
   * 'md' (default) is the historic width every popup uses. 'xl' matches the
   * practice sector selector's own `max-w-xl`, so the cells/asteroids
   * drill-down is not squeezed into a narrower shell than practice renders in.
   */
  size?: 'md' | 'xl';
}) {
  // Esc closes, like the Pug Shooter options popup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onCancel} />
      <div className={`relative w-full ${size === 'xl' ? 'max-w-xl' : 'max-w-md'} max-h-[80vh] flex flex-col bg-[#041010]/95 border border-[#00FFD1]/30 rounded-2xl shadow-[0_0_60px_rgba(0,255,209,0.15)] font-mono overflow-hidden`}>
        <div className="flex items-start justify-between gap-3 p-5 border-b border-[#00FFD1]/15">
          <div className="text-left">
            <h3 className="text-white font-black uppercase text-xs tracking-[0.25em]">{title}</h3>
            {subtitle && (
              <p className="mt-1 text-[9px] uppercase tracking-[0.25em] text-[#B1C5FF]/40">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onCancel}
            title="Close"
            className="shrink-0 p-1.5 rounded-full border border-[#00FFD1]/30 text-white/70 hover:text-white hover:border-[#00FFD1] hover:bg-[#00FFD1]/10 transition-all cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 custom-scrollbar">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ONLINE FRIEND PICKER — entry A step 1, and the room's INVITE button
// ---------------------------------------------------------------------------

export interface OnlineFriendPickerProps {
  title?: string;
  subtitle?: string;
  /** Usernames already seated / already invited — shown greyed out. */
  excludeUsernames?: string[];
  onPick: (username: string) => void;
  onCancel: () => void;
}

/**
 * Lists the ACCEPTED friends who are currently ONLINE. Offline friends are
 * shown below, disabled, so the list never looks empty-and-broken — the server
 * refuses an invite to somebody who is not connected anyway
 * (`private:error { code:'friend_offline' }`).
 */
export function OnlineFriendPicker({
  title = 'Invite a friend',
  subtitle,
  excludeUsernames = [],
  onPick,
  onCancel,
}: OnlineFriendPickerProps) {
  const [friends, setFriends] = useState<FriendEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // One load on open; presence flips are patched in by the socket below so we
  // never poll the API.
  useEffect(() => {
    let alive = true;
    socialApi
      .friends()
      .then((list) => {
        if (alive) setFriends(list.friends);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setFriends([]);
        setError(err instanceof Error ? err.message : 'Could not load your friends');
      });
    return () => {
      alive = false;
    };
  }, []);

  // Live presence: the server pushes the full set of online friend usernames
  // on connect and whenever one flips (design contract, `social:presence`).
  useEffect(() => {
    const socket = getSocket();
    const onOnline = (data: { usernames?: string[] }) => {
      const online = new Set(Array.isArray(data?.usernames) ? data.usernames : []);
      setFriends((prev) =>
        prev ? prev.map((f) => ({ ...f, online: online.has(f.username) })) : prev
      );
    };
    socket.on('social:friendsOnline', onOnline);
    return () => {
      socket.off('social:friendsOnline', onOnline);
    };
  }, []);

  const excluded = useMemo(
    () => new Set(excludeUsernames.map((name) => name.toLowerCase())),
    [excludeUsernames]
  );

  const { online, offline } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (friends ?? [])
      .filter((f) => f.status === 'accepted')
      .filter((f) => (q ? f.username.toLowerCase().includes(q) : true))
      .sort((a, b) => a.username.localeCompare(b.username));
    return {
      online: matches.filter((f) => f.online),
      offline: matches.filter((f) => !f.online),
    };
  }, [friends, query]);

  return (
    <PrivateWagerModal title={title} subtitle={subtitle} onCancel={onCancel}>
      {/* Filter box — a local filter over YOUR friends, not a user search.
          (Global username search lives in the Friends panel and is rate
          limited server-side; nothing here can enumerate strangers.) */}
      <label className="flex items-center gap-2 px-3 py-2 mb-4 rounded-lg bg-[#111E1E]/80 border border-[#00FFD1]/20">
        <Search className="w-3.5 h-3.5 text-[#00FFD1]/60 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="FILTER FRIENDS"
          className="flex-1 min-w-0 bg-transparent outline-none text-[11px] uppercase tracking-widest text-white placeholder:text-white/25"
        />
      </label>

      {friends === null && (
        <div className="flex items-center justify-center gap-2 py-8 text-[10px] uppercase tracking-[0.25em] text-[#B1C5FF]/50">
          <LoaderCircle className="w-4 h-4 animate-spin" />
          Loading friends
        </div>
      )}

      {error && (
        <p className="text-[10px] uppercase tracking-[0.2em] text-[#FF6B9A] mb-3">{error}</p>
      )}

      {friends !== null && online.length === 0 && offline.length === 0 && (
        <p className="py-8 text-center text-[10px] uppercase tracking-[0.25em] text-[#B1C5FF]/40">
          No friends yet — add some from the Friends panel
        </p>
      )}

      {online.length > 0 && (
        <>
          <p className="text-[9px] uppercase tracking-[0.3em] text-[#00FFD1]/60 mb-2">
            Online · {online.length}
          </p>
          <ul className="space-y-1.5 mb-5">
            {online.map((friend) => {
              const already = excluded.has(friend.username.toLowerCase());
              return (
                <li key={friend.username}>
                  <button
                    type="button"
                    disabled={already}
                    onClick={() => onPick(friend.username)}
                    className={`w-full flex items-center gap-3 p-2.5 rounded-lg border transition-all text-left ${
                      already
                        ? 'border-transparent opacity-40 cursor-default'
                        : 'border-[#00FFD1]/20 hover:border-[#00FFD1] hover:bg-[#00FFD1]/10 cursor-pointer'
                    }`}
                  >
                    <FriendAvatar username={friend.username} online />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-white tracking-wide truncate">
                        {friend.username}
                      </span>
                      <span className="block text-[9px] uppercase tracking-[0.2em] text-[#00FFD1]/60 mt-0.5">
                        {friend.rank}
                      </span>
                    </span>
                    {already ? (
                      <Check className="w-4 h-4 text-[#00FFD1] shrink-0" />
                    ) : (
                      <Swords className="w-4 h-4 text-[#00FFD1]/70 shrink-0" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {offline.length > 0 && (
        <>
          <p className="text-[9px] uppercase tracking-[0.3em] text-white/25 mb-2">
            Offline · {offline.length}
          </p>
          <ul className="space-y-1.5">
            {offline.map((friend) => (
              <li
                key={friend.username}
                className="w-full flex items-center gap-3 p-2.5 rounded-lg border border-transparent opacity-40"
              >
                <FriendAvatar username={friend.username} online={false} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-white/80 tracking-wide truncate">
                    {friend.username}
                  </span>
                  <span className="block text-[9px] uppercase tracking-[0.2em] text-white/30 mt-0.5">
                    {friend.rank}
                  </span>
                </span>
                <Ban className="w-4 h-4 text-white/30 shrink-0" />
              </li>
            ))}
          </ul>
        </>
      )}
    </PrivateWagerModal>
  );
}

/** Small avatar disc + presence dot. No image is fetched — usernames only. */
export function FriendAvatar({ username, online }: { username: string; online: boolean }) {
  return (
    <span className="relative shrink-0">
      <span className="w-8 h-8 rounded-full bg-gradient-to-br from-[#00FFD1]/40 to-[#0452c4]/40 border border-[#00FFD1]/25 flex items-center justify-center text-[11px] font-black text-[#081616] uppercase">
        {username.slice(0, 1)}
      </span>
      <span
        className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#041010] ${
          online ? 'bg-[#00FFD1]' : 'bg-white/25'
        }`}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// GAME / MODE PICKER — entry B step 1 (the friend is already known)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SECTOR GAMES (cells + asteroids) — the practice drill-down, reused verbatim
//
// Rather than cloning the practice markup, the invite picker renders the ACTUAL
// practice selector component for these two games, so the layout can never
// drift from practice. `includeFreeSector={false}` is what keeps FREE SECTOR /
// INFINITE (difficulty 1) unreachable from a private wager — the server catalog
// has no entry for it.
//
// The selector speaks difficulty numbers (10..13); this file translates them to
// the 'sector:mode' composite ids the server's privateMatch CATALOG is keyed by.
// ---------------------------------------------------------------------------

/** Games whose mode step is the sector drill-down instead of a flat mode list. */
const SECTOR_DRILLDOWN_GAMES = new Set<PrivateGameKey>(['cells', 'asteroids']);

/** Confirm-button label for the private-wager drill-down. */
const SECTOR_CONFIRM_LABEL = 'Send Invite';

// Module scope on purpose: these objects are a `useMemo` dependency inside the
// selector, so an inline literal would rebuild its merged copy table on every
// render. Wording matches the online lines the lobbies already agreed on.
const CELLS_PRIVATE_COPY: Partial<Record<CellsSectorId, CellsSectorCopy>> = {
  eclipse: {
    submodes: {
      10: { desc: 'Points for every kill. No winner, no loser.' },
      11: { desc: 'Collapsing zones. Last cell alive wins.' },
    },
  },
  blitz: {
    submodes: {
      12: { desc: 'Ranked purely by kill count. Nobody is crowned.' },
      13: { desc: 'Last one left wins. Defence is a strategy.' },
    },
  },
};

const ASTEROIDS_PRIVATE_COPY: Partial<Record<AsteroidsSectorId, AsteroidsSectorCopy>> = {
  eclipse: {
    submodes: {
      10: { desc: 'Points for every kill. No winner, no loser.' },
      11: { desc: 'Collapsing zones. Last hull alive wins.' },
    },
  },
  blitz: {
    submodes: {
      12: { desc: 'Ranked purely by kill count. Nobody is crowned.' },
      13: { desc: 'Last one left wins. Defence is a strategy.' },
    },
  },
};

export interface PrivateWagerInviteProps {
  /** Who the sidebar wants to challenge. Username ONLY — never a wallet. */
  username: string;
  onCancel: () => void;
  /** Chosen game + mode. The caller opens `PrivateWagerRoom` with these. */
  onLaunch: (choice: { gameKey: PrivateGameKey; mode: string }) => void;
}

/**
 * "Challenge <username> to a private wager" — pick the game, then the mode.
 * Every pair offered here exists in the server catalog, so `private:create`
 * can't be refused with `bad_mode`.
 */
export default function PrivateWagerInvite({
  username,
  onCancel,
  onLaunch,
}: PrivateWagerInviteProps) {
  const [gameKey, setGameKey] = useState<PrivateGameKey | null>(null);
  const game = gameKey ? privateWagerGame(gameKey) : undefined;

  // Cells + asteroids: the practice drill-down owns the mode step. The number
  // it emits is translated to a composite CATALOG id on confirm.
  const isSectorGame = gameKey !== null && SECTOR_DRILLDOWN_GAMES.has(gameKey);
  const [difficulty, setDifficulty] = useState<number>(CELLS_DEFAULT_ONLINE_DIFFICULTY);

  const openGame = useCallback((key: PrivateGameKey) => {
    // Fresh drill-down every time: back to the sector list, first submode armed.
    setDifficulty(
      key === 'asteroids' ? ASTEROIDS_DEFAULT_ONLINE_DIFFICULTY : CELLS_DEFAULT_ONLINE_DIFFICULTY
    );
    setGameKey(key);
  }, []);

  const launchSector = useCallback(() => {
    if (gameKey !== 'cells' && gameKey !== 'asteroids') return;
    const mode =
      gameKey === 'cells'
        ? cellsDifficultyToCompositeMode(difficulty)
        : asteroidsDifficultyToCompositeMode(difficulty);
    // null means free play / unknown — never a catalog key, so never launched.
    if (!mode) return;
    onLaunch({ gameKey, mode });
  }, [gameKey, difficulty, onLaunch]);

  return (
    <PrivateWagerModal
      title={game ? `${game.title} · select mode` : 'Private wager'}
      subtitle={`Challenge ${username}`}
      onCancel={onCancel}
      size={isSectorGame ? 'xl' : 'md'}
    >
      {!game ? (
        <ul className="grid grid-cols-1 gap-1.5">
          {PRIVATE_WAGER_GAMES.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                onClick={() => openGame(entry.key)}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-[#00FFD1]/20 hover:border-[#00FFD1] hover:bg-[#00FFD1]/10 transition-all cursor-pointer text-left"
              >
                <Swords className="w-4 h-4 text-[#00FFD1]/70 shrink-0" />
                <span className="flex-1 text-sm text-white uppercase tracking-wide italic font-black">
                  {entry.title}
                </span>
                <span className="text-[9px] uppercase tracking-[0.2em] text-[#B1C5FF]/40">
                  {entry.modes.length} {entry.modes.length === 1 ? 'mode' : 'modes'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : gameKey === 'cells' ? (
        // Identical component practice renders — free sector excluded.
        <CellsDifficultySelector
          selectedDifficulty={difficulty}
          onSelect={setDifficulty}
          onConfirm={launchSector}
          onCancel={() => setGameKey(null)}
          includeFreeSector={false}
          confirmLabel={SECTOR_CONFIRM_LABEL}
          copy={CELLS_PRIVATE_COPY}
        />
      ) : gameKey === 'asteroids' ? (
        <AsteroidsDifficultySelector
          selectedDifficulty={difficulty}
          onSelect={setDifficulty}
          onConfirm={launchSector}
          onCancel={() => setGameKey(null)}
          includeFreeSector={false}
          confirmLabel={SECTOR_CONFIRM_LABEL}
          copy={ASTEROIDS_PRIVATE_COPY}
        />
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-1.5">
            {game.modes.map((mode) => (
              <li key={mode.id}>
                <button
                  type="button"
                  onClick={() => onLaunch({ gameKey: game.key, mode: mode.id })}
                  className="w-full flex items-center gap-3 p-3 rounded-lg border border-[#00FFD1]/20 hover:border-[#00FFD1] hover:bg-[#00FFD1]/10 transition-all cursor-pointer text-left"
                >
                  <span className="flex-1">
                    <span className="block text-sm text-white uppercase tracking-wide italic font-black">
                      {mode.label}
                    </span>
                    {mode.hint && (
                      <span className="block text-[9px] uppercase tracking-[0.2em] text-[#B1C5FF]/40 mt-0.5">
                        {mode.hint}
                      </span>
                    )}
                  </span>
                  <span className="text-[9px] uppercase tracking-[0.2em] text-[#00FFD1]/60">
                    {mode.capacity} seats
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setGameKey(null)}
            className="mt-4 w-full py-2 rounded-lg border border-[#00FFD1]/25 text-[10px] uppercase tracking-[0.25em] text-[#B1C5FF]/60 hover:text-white hover:border-[#00FFD1]/60 transition-all cursor-pointer"
          >
            Back to games
          </button>
        </>
      )}
    </PrivateWagerModal>
  );
}

// ---------------------------------------------------------------------------
// INCOMING INVITES — moved to src/notifications/
// ---------------------------------------------------------------------------
/**
 * `usePrivateInvites` and `PrivateInviteToasts` used to live here. They now
 * live in the app-wide notification store (src/notifications/), because an
 * incoming `private:invited` push has three destinations, not one:
 *
 *   - the nav-bar notification centre (with a JOIN button),
 *   - the sidebar's ONLINE FRIENDS row for that friend (hover → JOIN),
 *   - an in-app pop-up — which is SUPPRESSED mid-match and replayed after.
 *
 * The socket is a singleton, so exactly ONE listener may exist for that event;
 * keeping a second one here would have shown every invite twice. See
 * `NotificationsSocketBridge` for the listener and `useNotifications()` for
 * the read side (`invites`, `inviteFrom`, `acceptInvite`).
 */

// ---------------------------------------------------------------------------
// SIDEBAR BRIDGE — entry B, with zero coupling to the sidebar's internals
// ---------------------------------------------------------------------------

/**
 * The sidebar's online-friends hover invite button calls
 * `openPrivateWagerInvite(friend.username)`; `PrivateWagerHost` (mounted once,
 * app-level) hears it and opens the game/mode picker.
 *
 * A window CustomEvent rather than a prop chain on purpose: SidebarMenu is
 * owned by another agent and lives far from wherever the room gets mounted.
 */
export const PRIVATE_WAGER_INVITE_EVENT = 'neon-arcade:private-wager-invite';

export function openPrivateWagerInvite(username: string): void {
  window.dispatchEvent(
    new CustomEvent(PRIVATE_WAGER_INVITE_EVENT, { detail: { username } })
  );
}

/** Subscribe to the bridge above. Returns the cleanup, React-effect ready. */
export function usePrivateWagerInviteRequests(
  onRequest: (username: string) => void
): void {
  const handlerRef = useRef(onRequest);
  handlerRef.current = onRequest;

  useEffect(() => {
    const onEvent = (event: Event) => {
      const username = (event as CustomEvent<{ username?: string }>).detail?.username;
      if (typeof username === 'string' && username.length > 0) {
        handlerRef.current(username);
      }
    };
    window.addEventListener(PRIVATE_WAGER_INVITE_EVENT, onEvent);
    return () => window.removeEventListener(PRIVATE_WAGER_INVITE_EVENT, onEvent);
  }, []);
}

// ---------------------------------------------------------------------------
// START BRIDGE — "the private match just began, mount your online screen"
// ---------------------------------------------------------------------------
/**
 * WHY THIS EXISTS
 * ---------------
 * A private room does not run the game: when everyone is ready the server
 * drives each player's NORMAL matchmaking, and the game's own start event
 * (`gameStart`, `volleyGameStart`, `neonconnect_match`, `triviaGameStart`,
 * `freeplay:match_found`, `lobbyGame:start`) lands a tick later. That only
 * works if a component is LISTENING for it.
 *
 * Chess, Volley and the three iframe games keep their listener mounted for the
 * whole screen, so they need nothing. But Neon Connect, Neon Quiz, Neon Cells
 * and Neon Asteroids only mount their online screen on demand — which is why
 * each of their lobbies passes `onStarted` to the room it opens itself.
 *
 * A room opened from the NAV BAR (accepting an invite) has no lobby to pass
 * that prop, so those four would start a real match with nobody listening and
 * strand the player on whatever screen they were on. This event closes that
 * gap: the app-level host announces the start, and those four lobbies — which
 * the host has already navigated to, so they ARE mounted — run the same
 * handler they would have passed as `onStarted`.
 *
 * Keyed by `gameKey` so a Quiz start can't wake the Cells lobby.
 */
export const PRIVATE_WAGER_STARTED_EVENT = 'neon-arcade:private-wager-started';

export interface PrivateWagerStartedDetail {
  gameKey: PrivateGameKey;
  mode: string;
}

export function announcePrivateWagerStarted(
  gameKey: PrivateGameKey,
  mode: string
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<PrivateWagerStartedDetail>(PRIVATE_WAGER_STARTED_EVENT, {
      detail: { gameKey, mode },
    })
  );
}

/**
 * Lobby side of the bridge. Pass the SAME thing you pass to `onStarted` on
 * your own `<PrivateWagerRoom>` — it is the identical handoff, just triggered
 * by a room this lobby did not open.
 */
export function usePrivateWagerStarted(
  gameKey: PrivateGameKey,
  onStarted: (mode: string) => void
): void {
  const handlerRef = useRef(onStarted);
  handlerRef.current = onStarted;

  useEffect(() => {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<Partial<PrivateWagerStartedDetail>>).detail;
      if (detail?.gameKey !== gameKey || typeof detail.mode !== 'string') return;
      handlerRef.current(detail.mode);
    };
    window.addEventListener(PRIVATE_WAGER_STARTED_EVENT, onEvent);
    return () => window.removeEventListener(PRIVATE_WAGER_STARTED_EVENT, onEvent);
  }, [gameKey]);
}
