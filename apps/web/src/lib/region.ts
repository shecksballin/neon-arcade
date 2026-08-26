/**
 * REGION PREFERENCE — which regional game server this client talks to.
 *
 * A region is a separate player pool (see @neon/types GAME_REGIONS): the
 * choice rides on every API fetch (`x-neon-region` header, lib/api.ts) and
 * on the socket handshake (`region` query, hooks/useGameSocket.ts); the
 * server replays mismatched requests to the right region via fly-replay.
 *
 * localStorage is the fast local copy; the account row (users.region) is
 * the durable one — App syncs server → local on /me when local is unset,
 * and the pickers write BOTH.
 */
import { DEFAULT_REGION, isGameRegion } from '@neon/types';

const KEY = 'neon_region';

type Listener = (region: string) => void;
const listeners = new Set<Listener>();

/** The chosen region, or the default when nothing was ever picked. */
export function getRegion(): string {
  try {
    const raw = localStorage.getItem(KEY);
    return raw && isGameRegion(raw) ? raw : DEFAULT_REGION;
  } catch {
    return DEFAULT_REGION;
  }
}

/** True only when the player has explicitly picked (vs the default). */
export function hasChosenRegion(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    return !!raw && isGameRegion(raw);
  } catch {
    return false;
  }
}

export function setRegion(region: string): void {
  if (!isGameRegion(region)) return;
  try {
    localStorage.setItem(KEY, region);
  } catch {
    /* private mode — the in-memory default still applies */
  }
  for (const fn of listeners) fn(region);
}

/** Subscribe to changes (the socket layer reconnects on this). */
export function onRegionChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
