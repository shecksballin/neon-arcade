/**
 * Chess practice-mode difficulty tiers.
 *
 * Each tier maps a friendly label to a Stockfish "Skill Level" (0–20),
 * which is what the client-side engine consumes via
 * useComputerMove -> stockfishEngine.bestMove({ skillLevel }).
 *
 * Shared by the lobby (GameLobby) and the in-game sidebar (ComputerGame)
 * so both edit one source of truth.
 */
export interface ChessDifficulty {
  id: string;
  label: string;
  /** Stockfish Skill Level, 0 (weakest) – 20 (full strength). */
  skillLevel: number;
}

export const CHESS_DIFFICULTIES: ChessDifficulty[] = [
  { id: 'beginner', label: 'Beginner', skillLevel: 2 },
  { id: 'casual',   label: 'Casual',   skillLevel: 5 },
  { id: 'skilled',  label: 'Skilled',  skillLevel: 9 },
  { id: 'expert',   label: 'Expert',   skillLevel: 14 },
  { id: 'master',   label: 'Master',   skillLevel: 20 },
];

/** Default tier ("Skilled") — a strong-but-fair middle. */
export const DEFAULT_SKILL_LEVEL = 9;

/** Nearest tier for a given skill level (for labelling an arbitrary value). */
export function difficultyForSkill(skill: number): ChessDifficulty {
  return CHESS_DIFFICULTIES.reduce(
    (best, d) =>
      Math.abs(d.skillLevel - skill) < Math.abs(best.skillLevel - skill) ? d : best,
    CHESS_DIFFICULTIES[0],
  );
}
