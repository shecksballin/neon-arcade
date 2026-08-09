import { useCallback, useEffect } from 'react';
import { stockfish } from './stockfishEngine';

/**
 * Provides the computer opponent's moves for chess practice mode.
 *
 * Backed by a client-side Stockfish 18 Web Worker (see stockfishEngine.ts).
 * Previously this POSTed to a server `/api/chess/move` route that no longer
 * exists on the Hono backend, so practice mode silently made no moves.
 *
 * API is unchanged for callers: getBestMove(fen, { skillLevel, depth }) →
 * Promise<UCI string> (e.g. "e2e4", "e7e8q"), or "" on failure/no move.
 */
export function useComputerMove() {
  // Warm the engine on mount so the first move isn't delayed by the WASM
  // download/compile. The engine is kept alive across games.
  useEffect(() => {
    stockfish.warmup();
  }, []);

  const getBestMove = useCallback(
    async (
      fen: string,
      { depth, skillLevel = 10 }: { depth?: number; skillLevel?: number } = {},
    ): Promise<string> => {
      try {
        return await stockfish.bestMove(fen, { skillLevel, depth });
      } catch (err) {
        console.error('[useComputerMove] engine failed:', err);
        return '';
      }
    },
    [],
  );

  return { getBestMove };
}
