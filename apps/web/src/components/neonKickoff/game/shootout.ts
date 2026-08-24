import type { Side } from './types';

/**
 * Pure penalty-shootout bookkeeping, mirroring the real rules:
 *  - best of 5 kicks each, sides alternate (player always kicks first here)
 *  - the shootout ends early the moment one side can no longer be caught
 *  - level after 5 each -> sudden death, one kick each per round
 */
export interface ShootoutState {
  /** per-attempt results, true = scored. index = kick number - 1 */
  kicks: Record<Side, boolean[]>;
  winner: Side | null;
}

export const REGULATION = 5;

export function createShootout(): ShootoutState {
  return { kicks: { player: [], ai: [] }, winner: null };
}

export function goals(s: ShootoutState, side: Side): number {
  return s.kicks[side].filter(Boolean).length;
}

export function taken(s: ShootoutState, side: Side): number {
  return s.kicks[side].length;
}

/** whose kick is next (player leads every round) */
export function nextKicker(s: ShootoutState): Side {
  return taken(s, 'player') <= taken(s, 'ai') ? 'player' : 'ai';
}

/** 1-based round number of the NEXT kick */
export function roundNumber(s: ShootoutState): number {
  return Math.min(taken(s, 'player'), taken(s, 'ai')) + 1;
}

export function inSuddenDeath(s: ShootoutState): boolean {
  return taken(s, 'player') >= REGULATION && taken(s, 'ai') >= REGULATION;
}

function decide(s: ShootoutState): Side | null {
  const gp = goals(s, 'player');
  const ga = goals(s, 'ai');
  const tp = taken(s, 'player');
  const ta = taken(s, 'ai');

  if (tp <= REGULATION && ta <= REGULATION) {
    // regulation: decided as soon as the deficit exceeds the kicks left
    // (covers the full-10-kicks case too: with no kicks left, any lead decides)
    const leftP = REGULATION - tp;
    const leftA = REGULATION - ta;
    if (gp > ga + leftA) return 'player';
    if (ga > gp + leftP) return 'ai';
    return null;
  }
  // sudden death: judged only once both have taken the same number of kicks
  if (tp === ta && tp > REGULATION) {
    if (gp !== ga) return gp > ga ? 'player' : 'ai';
  }
  return null;
}

export function recordKick(s: ShootoutState, side: Side, scored: boolean): ShootoutState {
  const next: ShootoutState = {
    kicks: {
      player: side === 'player' ? [...s.kicks.player, scored] : s.kicks.player,
      ai: side === 'ai' ? [...s.kicks.ai, scored] : s.kicks.ai,
    },
    winner: null,
  };
  next.winner = decide(next);
  return next;
}
