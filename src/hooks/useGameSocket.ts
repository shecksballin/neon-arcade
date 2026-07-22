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
} from '../types';

const SOCKET_URL = import.meta.env.VITE_WS_URL ?? 'http://localhost:3000';

// Global socket instance (singleton)
let socketInstance: Socket | null = null;

export function getSocket() {
  if (!socketInstance) {
    socketInstance = io(SOCKET_URL, {
      autoConnect: false,
      reconnection: true,
    });
  }
  return socketInstance;
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
