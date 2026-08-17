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
  // download/compile, and hand the worker back when chess is left.
  //
  // The engine stays alive across GAMES because this hook is mounted by
  // ChessGame — the top-level chess view — which survives lobby → practice →
  // lobby. It only unmounts when the player exits to the arcade, and at that
  // point a Stockfish WASM worker is tens of MB of RAM and a live thread doing
  // nothing for a game nobody is playing.
  useEffect(() => {
    stockfish.warmup();
    return () => stockfish.dispose();
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
