import { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";

// ─── Config ───────────────────────────────────────────────────────────────────

const SOCKET_URL = "";
const HEARTBEAT_INTERVAL_MS = 20_000;  // send heartbeat every 20s
const RECONNECT_BASE_DELAY_MS = 1_000; // start retry at 1s
const RECONNECT_MAX_DELAY_MS = 30_000; // cap retry at 30s
const RECONNECT_MAX_ATTEMPTS = 10;

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseActiveUsersOptions {
  enabled?: boolean;
}

interface UseActiveUsersResult {
  activeUsers: number;
  connected: boolean;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function isValidPayload(payload: unknown): payload is { activeUsers: number } {
  if (typeof payload !== "object" || payload === null) return false;
  const { activeUsers } = payload as { activeUsers: unknown };
  // Number.isInteger rejects floats, NaN, Infinity, strings, null
  return Number.isInteger(activeUsers) && (activeUsers as number) >= 0;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
// Anonymous presence — no wallet, no token. Counts everyone on the page.
// The server issues its own session id, so the client sends no identity at all.

export function useActiveUsers({
  enabled = true,
}: UseActiveUsersOptions = {}): UseActiveUsersResult {
  const [activeUsers, setActiveUsers] = useState(0);
  const [connected, setConnected] = useState(false);
  const [settled, setSettled] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectAttemptsRef.current >= RECONNECT_MAX_ATTEMPTS) return;

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttemptsRef.current,
      RECONNECT_MAX_DELAY_MS
    );
    reconnectAttemptsRef.current += 1;

    reconnectTimerRef.current = setTimeout(() => {
      connectRef.current?.();
    }, delay);
  }, []);

  // connect is referenced inside scheduleReconnect via ref to avoid stale closures
  const connectRef = useRef<(() => void) | null>(null);

  const connect = useCallback(() => {
    if (!enabled) return;
    if (socketRef.current?.connected) return;

    const socket = io(undefined, {
      // No auth payload — anonymous by design. Server assigns the session id.
      reconnection: false,         // we handle reconnect manually with backoff
      transports: ["polling", "websocket"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setSettled(false);
      reconnectAttemptsRef.current = 0;

      // Settle period: ignore initial ghost inflated counts
      settleTimerRef.current = setTimeout(() => {
        setSettled(true);
      }, 5000);

      heartbeatRef.current = setInterval(() => {
        if (socket.connected) socket.emit("heartbeat");
      }, HEARTBEAT_INTERVAL_MS);
    });

    socket.on("presence:update", (payload: unknown) => {
      if (!isValidPayload(payload)) return; // reject malformed server messages
      setActiveUsers(payload.activeUsers);
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setSettled(false);
      setActiveUsers(0);
      clearTimers();
      scheduleReconnect();
    });

    socket.on("connect_error", () => {
      setConnected(false);
      setSettled(false);
      setActiveUsers(0);
      clearTimers();
      socket.disconnect();
      scheduleReconnect();
    });
  }, [enabled, clearTimers, scheduleReconnect]);

  connectRef.current = connect;

  useEffect(() => {
    connect();

    return () => {
      clearTimers();
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setConnected(false);
      setSettled(false);
      setActiveUsers(0);
    };
  }, [connect, clearTimers]);

  return { activeUsers: settled ? activeUsers : 0, connected };
}
