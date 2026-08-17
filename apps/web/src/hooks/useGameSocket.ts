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
export const SOCKET_URL =
  import.meta.env.VITE_WS_URL ??
  import.meta.env.VITE_API_URL ??
  'http://localhost:3002';

// Same localStorage key useBackendAuth writes the backend JWT under.
const AUTH_TOKEN_KEY = 'token';

// Global socket instance (singleton). Every 1v1 game (chess, volley, trivia,
// neon connect) shares this ONE authenticated connection — no more per-game
// bare io() calls at module import time.
let socketInstance: Socket | null = null;

export function getSocket(): Socket {
  if (!socketInstance) {
    socketInstance = io(SOCKET_URL, {
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
