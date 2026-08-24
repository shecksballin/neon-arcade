import { useFrame } from '@react-three/fiber';
import { advance } from '../tick';

/**
 * The game's only timer. Every phase advances off frame deltas, so pausing the
 * render loop pauses the whole match for free — no timeouts to chase.
 */
export function Ticker() {
  useFrame((_, dt) => {
    if (import.meta.env.DEV && (window as unknown as { __freeze?: boolean }).__freeze) return;
    advance(dt);
  });
  return null;
}
