import { useState, useEffect, useMemo, useRef } from 'react';
import { algebraicToIndex } from './gameUtils';
import { DEFAULT_POSITION } from './ChessBoard';

export type PieceObj = {
  id: string;
  type: string;
  color: string;
  currentSquare: number; // 0-63
  isCaptured: boolean;
};

// Compute pieces by fully replaying history
export function useChessPieces(history: any[]) {
  const [pieces, setPieces] = useState<PieceObj[]>([]);
  const [lastMove, setLastMove] = useState<any>(null);
  const [historyLength, setHistoryLength] = useState<number>(0);

  useEffect(() => {
    const registry = new Map<string, PieceObj>();
    const board = new Array(64).fill(null);
    
    // Initialize starting pieces
    DEFAULT_POSITION.forEach((p, i) => {
      if (p) {
        const id = `${p.color}_${p.type}_${i}`;
        const obj = { id, type: p.type, color: p.color, currentSquare: i, isCaptured: false };
        registry.set(id, obj);
        board[i] = obj;
      }
    });

    let currentMove = null;
    
    // Replay history
    for (const move of history) {
      currentMove = move;
      const fromIndex = algebraicToIndex(move.from);
      const toIndex = algebraicToIndex(move.to);
      
      // En passant capture
      if (move.flags.includes('e')) {
        const capturedSquare = move.color === 'w' ? toIndex + 8 : toIndex - 8;
        if (board[capturedSquare]) {
           board[capturedSquare].isCaptured = true;
           board[capturedSquare] = null;
        }
      } 
      // Standard capture
      else if (move.captured) {
         if (board[toIndex]) {
            board[toIndex].isCaptured = true;
         }
      }
      
      // Move the primary piece
      const piece = board[fromIndex];
      if (piece) {
         piece.currentSquare = toIndex;
         
         // Promotion
         if (move.promotion) {
            piece.type = move.promotion === 'q' ? 'queen' : 
                         move.promotion === 'r' ? 'rook' : 
                         move.promotion === 'b' ? 'bishop' : 'knight';
         }
         
         board[toIndex] = piece;
         board[fromIndex] = null;
      }
      
      // Castling
      if (move.flags.includes('k') || move.flags.includes('q')) {
         const row = move.color === 'w' ? 7 : 0;
         const isKingside = move.flags.includes('k');
         const rookFromCol = isKingside ? 7 : 0;
         const rookToCol = isKingside ? 5 : 3;
         const rookFromIndex = row * 8 + rookFromCol;
         const rookToIndex = row * 8 + rookToCol;
         
         const rook = board[rookFromIndex];
         if (rook) {
           rook.currentSquare = rookToIndex;
           board[rookToIndex] = rook;
           board[rookFromIndex] = null;
         }
      }
    }
    
    setPieces(Array.from(registry.values()));
    setLastMove(currentMove);
    setHistoryLength(history.length);
  }, [history]);

  return { pieces, lastMove, historyLength };
}
