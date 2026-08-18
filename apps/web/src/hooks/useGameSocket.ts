import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  KillRewardPayload,
  PlayerEliminatedPayload,
  PlayerRespawningPayload,
  PotUpdatePayload,
  MatchSettledPayload,
  CashOutConfirmedPayload,
  NotificationPayload,
  DuelRequestPayload,
  MessagePayload
} from '@neon/types';

// The ONE game-socket URL for the whole app. Priority: explicit websocket URL,
// then the HTTP API URL (socket.io shares port 3002 with the Hono server),
// then the local dev default.
//
// `||` rather than `??`, and trimmed: an env var that is set but EMPTY has to
// fall through as well. With `??` an empty string survives, and `io('/presence')`
// then resolves against window.location — the app would handshake with its own
// index.html and get HTML where it expects a socket.
const CONFIGURED_SOCKET_ORIGIN =
  import.meta.env.VITE_WS_URL?.trim() || import.meta.env.VITE_API_URL?.trim() || '';

/**
 * The game-socket origin, or NULL when this build was given none.
 *
 * WHY NULL RATHER THAN THE LOCALHOST DEFAULT.
 * Vite inlines `import.meta.env.VITE_*` at build time, so a deployment built
 * without these vars ships the literal string `http://localhost:3002` to every
 * visitor — and their browser dutifully tries to open a socket to *their own
 * machine's* port 3002 from a public HTTPS page. It cannot work (connection
 * refused, or Chrome's private-network block), and `useActiveUsers` is mounted
 * on the landing page for everyone, so the failure schedules a retry: 1s, 2s,
 * 4s, 8s, 16s, 30s… ten attempts, roughly two minutes of doomed requests per
 * page load, on every visit.
 *
 * Knowing we have no server is strictly better than spending two minutes
 * finding out.
 *
 * THE LOOPBACK CHECK IS NOT REDUNDANT with `import.meta.env.DEV`. `bun run
 * preview` — the workflow PERF_BRIEF.md tells you to use for every before /
 * after measurement — serves a PRODUCTION build, so DEV is false there. Keying
 * only on DEV would leave sockets dead in exactly the setup a developer uses
 * to check this change, while lib/api.ts happily kept talking to
 * localhost:3002. If the PAGE is on loopback, a local server is the right
 * assumption however the bundle was built.
 */
const ON_LOOPBACK =
  typeof window !== 'undefined' &&
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

export const SOCKET_URL: string | null =
  CONFIGURED_SOCKET_ORIGIN ||
  (import.meta.env.DEV || ON_LOOPBACK ? 'http://localhost:3002' : null);

// Same localStorage key useBackendAuth writes the backend JWT under.
const AUTH_TOKEN_KEY = 'token';

// Global socket instance (singleton). Every 1v1 game (chess, volley, trivia,
// neon connect) shares this ONE authenticated connection — no more per-game
// bare io() calls at module import time.
let socketInstance: Socket | null = null;

/** Says "this build has no game server" once, however many things ask. */
let warnedNoServer = false;
export function warnNoSocketServer(): void {
  if (warnedNoServer) return;
  warnedNoServer = true;
  console.warn(
    '[gameSocket] no server origin is configured for this build (VITE_API_URL / VITE_WS_URL) — ' +
      'online play and presence are unavailable. Local games are unaffected.'
  );
}

export function getSocket(): Socket {
  if (!socketInstance) {
    // `autoConnect: false`, so constructing this makes no request whatsoever.
    // When the build has no configured origin the fallback here is never
    // dialled either — connectGameSocket() refuses to connect (below) — it
    // exists only so the singleton keeps its non-null type for every caller.
    socketInstance = io(SOCKET_URL ?? window.location.origin, {
      autoConnect: false, // games connect lazily via connectGameSocket()
      reconnection: true,
      // Function form: socket.io invokes this on every (re)connect, so the
      // freshest token from localStorage is used even after a token refresh.
      auth: (cb) => cb({ token: localStorage.getItem(AUTH_TOKEN_KEY) }),
    });

    // Global auth-failure logging. Games layer their own status UI on top;
    // this guarantees the reason is at least visible in the console.
    socketInstance.on('connect_error', (err: Error) => {
      if (err.message === 'unauthorized' || err.message === 'auth_unavailable') {
        console.warn(
          `[gameSocket] connection rejected (${err.message}) — sign in and finish account setup to play online`
        );
      }
    });
  }
  return socketInstance;
}

/**
 * Connect the shared, authenticated game socket. Safe to call repeatedly —
 * it is a no-op when already connected. Returns the socket either way so
 * callers can bind listeners immediately (emits are buffered until connected).
 *
 * Without a stored token the socket stays disconnected: the server-side
 * handshake middleware would reject it anyway.
 */
export function connectGameSocket(): Socket {
  const socket = getSocket();
  // No configured server for this build (see SOCKET_URL). We still DIAL, and
  // that is deliberate: five online surfaces (onlineLobbyMatch, NeonConnect,
  // PrivateWagerRoom, Trivia, Volley) leave their "searching…" state only on
  // socket.io's `connect_error`, so refusing to connect here would replace a
  // visible "could not reach the arcade servers" with a lobby that spins for
  // ever. A failed dial reaches the same handlers it always did; it is only
  // the anonymous PRESENCE socket — mounted on the landing page for every
  // visitor, retried ten times over two minutes — that must stay silent.
  if (!SOCKET_URL) warnNoSocketServer();
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token && !socket.connected) {
    // Some socket.io-client versions ignore the function form of `auth`;
    // setting the plain object right before connect() covers both shapes.
    socket.auth = { token };
    socket.connect();
  } else if (!token) {
    console.warn('[gameSocket] no auth token stored — online play requires sign-in');
  }
  return socket;
}

/** Tear down the shared game socket (e.g. on sign-out). */
export function disconnectGameSocket(): void {
  socketInstance?.disconnect();
}

/**
 * Connects the socket when the user signs in (or mounts main app)
 * and disconnects on unmount.
 */
export function useSocketConnection(token?: string | null) {
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const socket = getSocket();

    if (token) {
      socket.auth = { token };
      socket.connect();
    } else {
      socket.disconnect();
    }

    const onConnect = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [token]);

  return { socket: getSocket(), isConnected };
}

/**
 * Game Result Listener (Listens for deaths, payouts, and match state changes)
 * Mirrors the logic from "Game result listener" and "Redistributing money"
 */
export function useMatchSocketEvents(matchId?: string) {
  useEffect(() => {
    if (!matchId) return;

    const socket = getSocket();

    // Join a specific match room
    socket.emit('join_match', { matchId });

    const handlers = {
      'kill_reward': (payload: KillRewardPayload) => {
        console.log('[Socket] Kill Reward:', payload);
        // Dispatch to UI or query cache
      },
      'player_eliminated': (payload: PlayerEliminatedPayload) => {
        console.log('[Socket] Player Eliminated:', payload);
      },
      'player_respawning': (payload: PlayerRespawningPayload) => {
        console.log('[Socket] Player Respawning:', payload);
      },
      'pot_update': (payload: PotUpdatePayload) => {
        console.log('[Socket] Pot Update:', payload);
      },
      'match_settled': (payload: MatchSettledPayload) => {
        console.log('[Socket] Match Settled:', payload);
      },
      'cashout_confirmed': (payload: CashOutConfirmedPayload) => {
        console.log('[Socket] Cashout Confirmed:', payload);
      }
    };

    // Attach handlers
    Object.entries(handlers).forEach(([event, handler]) => socket.on(event, handler));

    return () => {
      socket.emit('leave_match', { matchId });
      Object.entries(handlers).forEach(([event, handler]) => socket.off(event, handler));
    };
  }, [matchId]);
}

/**
 * Social Events (Notifications, Invites, Dueling, Messaging)
 */
export function useSocialEvents() {
  useEffect(() => {
    const socket = getSocket();

    const handlers = {
      'notification': (payload: NotificationPayload) => {
        console.log('[Socket] New Notification:', payload);
        // Toast or invalidate queries
      },
      'duel_request': (payload: DuelRequestPayload) => {
        console.log('[Socket] Duel Request:', payload);
        // Show Duel Modal overlay
      },
      'new_message': (payload: MessagePayload) => {
        console.log('[Socket] New Message:', payload);
      }
    };

    Object.entries(handlers).forEach(([event, handler]) => socket.on(event, handler));

    return () => {
      Object.entries(handlers).forEach(([event, handler]) => socket.off(event, handler));
    };
  }, []);
}
