import type { Dir, Zone } from './types';

const DIRS: Dir[] = ['left', 'middle', 'right'];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * AI keeper: mostly reads the player's habits. 40% pure gamble, otherwise
 * lean toward the corner the player has favoured so far.
 */
export function aiKeeperGuess(history: Dir[]): Dir {
  if (history.length === 0 || Math.random() < 0.4) return pick(DIRS);
  const counts: Record<Dir, number> = { left: 0, middle: 0, right: 0 };
  for (const d of history) counts[d]++;
  const top = Math.max(counts.left, counts.middle, counts.right);
  return pick(DIRS.filter((d) => counts[d] === top));
}

/** AI striker: picks a corner freely; timing is usually clean, sometimes scuffed, rarely skied */
export function aiStrikerPlan(): { dir: Dir; zone: Zone } {
  const r = Math.random();
  const zone: Zone = r < 0.68 ? 'green' : r < 0.92 ? 'orange' : 'red';
  return { dir: pick(DIRS), zone };
}
