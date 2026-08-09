import type { DifficultyTier } from '../common/DifficultySelector';

/**
 * Neon Connect computer-opponent difficulty.
 *
 * The base AI is a heuristic (take win → maybe block → prefer center). These
 * tiers modulate its strength via `connectAiConfig`:
 *   - blunderChance: probability of ignoring strategy and playing a random
 *     column this turn (models a mistake — lets weak bots miss blocks).
 *   - avoidTraps: don't play a move that hands the opponent an immediate win.
 *   - seekThreats: prefer moves that set up the bot's own winning threat.
 * Default (Medium) ≈ the previous fixed behaviour.
 */
export const CONNECT_DIFFICULTIES: DifficultyTier[] = [
  { id: 'rookie', label: 'Rookie', value: 1 },
  { id: 'easy', label: 'Easy', value: 2 },
  { id: 'medium', label: 'Medium', value: 3 },
  { id: 'hard', label: 'Hard', value: 4 },
  { id: 'insane', label: 'Insane', value: 5 },
];

export const CONNECT_DEFAULT_DIFFICULTY = 3;

export interface ConnectAiConfig {
  blunderChance: number;
  avoidTraps: boolean;
  seekThreats: boolean;
}

export function connectAiConfig(value: number): ConnectAiConfig {
  switch (value) {
    case 1:  return { blunderChance: 0.55, avoidTraps: false, seekThreats: false };
    case 2:  return { blunderChance: 0.30, avoidTraps: false, seekThreats: false };
    case 3:  return { blunderChance: 0.12, avoidTraps: true,  seekThreats: false };
    case 4:  return { blunderChance: 0.0,  avoidTraps: true,  seekThreats: false };
    case 5:  return { blunderChance: 0.0,  avoidTraps: true,  seekThreats: true  };
    default: return { blunderChance: 0.12, avoidTraps: true,  seekThreats: false };
  }
}

const HINTS: Record<number, string> = {
  1: 'Plays almost at random',
  2: 'Often misses blocks',
  3: 'Blocks & takes wins',
  4: "Won't hand you a win",
  5: 'Sets up double threats',
};

export const connectDifficultyCaption = (value: number): string =>
  HINTS[value] ?? '';
