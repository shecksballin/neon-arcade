import type { DifficultyTier } from '../common/DifficultySelector';

/**
 * Neon Volley computer-opponent tiers. `value` is the difficulty level
 * (1–5) that the paddle AI in PingPongGame already consumes — kept
 * identical so the bot behaviour is unchanged; only the picker UI moved
 * to the shared pill selector.
 */
export const VOLLEY_DIFFICULTIES: DifficultyTier[] = [
  { id: 'training', label: 'Training', value: 1 },
  { id: 'amateur', label: 'Amateur', value: 2 },
  { id: 'pro', label: 'Professional', value: 3 },
  { id: 'apex', label: 'Apex AI', value: 5 },
];

export const VOLLEY_DEFAULT_DIFFICULTY = 3;

/** Small caption hint shown under the pills. */
export const volleyDifficultyCaption = (value: number): string =>
  `Reaction ${value * 4}/20`;
