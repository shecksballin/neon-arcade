import type { ConnectAiConfig } from './connectDifficulty';

export interface ConnectAiHelpers {
  COLS: number;
  HUMAN: number;
  OPPONENT: number;
  /** Lowest empty row for a column on the given board, or -1 if full. */
  getAvailableRow: (col: number, board: number[]) => number;
  checkWin: (board: number[], player: number) => boolean;
}

/**
 * Pure decision logic for the Neon Connect computer opponent. Returns the
 * column to play, or null if the board is full.
 *
 * Difficulty (via ConnectAiConfig) shapes the choice:
 *   1. Always take an immediate win.
 *   2. `blunderChance`: weaker tiers may bail to a random move here — which
 *      is how they end up missing an otherwise-forced block below.
 *   3. Block the human's immediate win.
 *   4. `avoidTraps`: drop columns that give the human a winning reply.
 *   5. `seekThreats`: prefer columns that set up the AI's own win.
 *   6. Otherwise prefer center, then random.
 *
 * `rng` is injectable so the behaviour is deterministically testable.
 */
export function chooseConnectAiMove(
  board: number[],
  cfg: ConnectAiConfig,
  helpers: ConnectAiHelpers,
  rng: () => number = Math.random,
): number | null {
  const { COLS, HUMAN, OPPONENT, getAvailableRow, checkWin } = helpers;

  const validMoves: number[] = [];
  for (let col = 0; col < COLS; col++) {
    if (getAvailableRow(col, board) !== -1) validMoves.push(col);
  }
  if (validMoves.length === 0) return null;

  const winsFor = (player: number, col: number, b: number[]): boolean => {
    const r = getAvailableRow(col, b);
    if (r === -1) return false;
    const t = [...b];
    t[r * COLS + col] = player;
    return checkWin(t, player);
  };
  const boardAfter = (player: number, col: number, b: number[]): number[] => {
    const r = getAvailableRow(col, b);
    const t = [...b];
    if (r !== -1) t[r * COLS + col] = player;
    return t;
  };
  const randOf = (cols: number[]) => cols[Math.floor(rng() * cols.length)];

  // 1. Always take an immediate win.
  for (const col of validMoves) {
    if (winsFor(OPPONENT, col, board)) return col;
  }

  // 2. Blunder: weaker tiers sometimes play randomly (and may miss a block).
  if (rng() < cfg.blunderChance) return randOf(validMoves);

  // 3. Block the human's immediate win.
  for (const col of validMoves) {
    if (winsFor(HUMAN, col, board)) return col;
  }

  // 4. Avoid a move that hands the human a winning reply.
  let candidates = validMoves;
  if (cfg.avoidTraps) {
    const safe = candidates.filter((col) => {
      const next = boardAfter(OPPONENT, col, board);
      return !validMoves.some((c2) => winsFor(HUMAN, c2, next));
    });
    if (safe.length > 0) candidates = safe;
  }

  // 5. Prefer moves that set up the AI's own winning threat.
  if (cfg.seekThreats) {
    const threats = candidates.filter((col) => {
      const next = boardAfter(OPPONENT, col, board);
      return candidates.some((c2) => winsFor(OPPONENT, c2, next));
    });
    if (threats.length > 0) candidates = threats;
  }

  // 6. Prefer center, else a random remaining candidate.
  return candidates.includes(3) ? 3 : randOf(candidates);
}
