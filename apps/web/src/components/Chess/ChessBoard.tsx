import React, { useRef, useEffect } from 'react';
import ChessPiece from './ChessPiece';
import { playCaptureSequence } from './animeTimeline';
import { useChessPieces } from './useChessPieces';
import { CombatTextOverlay } from './CombatTextOverlay';
import './chess.css';

/* ─── Default starting position ─────────────────────────────────────────── */
const B = 'black';
const W = 'white';
const p = (type: string, color: string) => ({ type, color });

const DEFAULT_POSITION = [
  // Row 8 – black back rank
  p('rook',   B), p('knight', B), p('bishop', B), p('queen',  B),
  p('king',   B), p('bishop', B), p('knight', B), p('rook',   B),
  // Row 7 – black pawns
  p('pawn', B), p('pawn', B), p('pawn', B), p('pawn', B),
  p('pawn', B), p('pawn', B), p('pawn', B), p('pawn', B),
  // Rows 6-3 – empty
  ...Array(32).fill(null),
  // Row 2 – white pawns
  p('pawn', W), p('pawn', W), p('pawn', W), p('pawn', W),
  p('pawn', W), p('pawn', W), p('pawn', W), p('pawn', W),
  // Row 1 – white back rank
  p('rook',   W), p('knight', W), p('bishop', W), p('queen',  W),
  p('king',   W), p('bishop', W), p('knight', W), p('rook',   W),
];

/* ─── Icon map ───────────────────────────────────────────────────────────── */
const ICON: Record<string, string> = {
  pawn:   'chess_pawn',
  rook:   'chess_rook',
  knight: 'chess_knight',
  bishop: 'chess_bishop',
  queen:  'chess_queen',
  king:   'chess_king',
};

/* ─── Component ──────────────────────────────────────────────────────────── */
interface ChessBoardProps {
  position?: any[];
  history?: any[];
  onSquareClick?: (index: number, piece: any) => void;
  highlightSquares?: number[];
  premoveSquares?: number[];
  premoves?: Array<{fromIndex: number, toIndex: number, promotion?: string}>;
  pendingPromotion?: {fromIndex: number, toIndex: number, color: 'w'|'b', isPremove: boolean} | null;
  resolvePromotion?: (piece: string) => void;
  isPremovePhase?: boolean;
  squareSize?: number;
  orientation?: 'white' | 'black';
}

const ChessBoard = ({
  position = DEFAULT_POSITION,
  history = [],
  onSquareClick,
  highlightSquares = [],
  premoveSquares = [],
  premoves = [],
  pendingPromotion,
  resolvePromotion,
  isPremovePhase = false,
  squareSize = 75,
  orientation = 'white',
}: ChessBoardProps) => {
  const boardRef = useRef<HTMLDivElement>(null);
  const prevHistoryLengthRef = useRef(0);
  const { pieces, lastMove, historyLength } = useChessPieces(history);
  
  const isNewMove = historyLength > prevHistoryLengthRef.current;

  // We need to keep track of the selected square index so we know which piece is selected.
  // Wait, selectedIndex is managed by useChessGame, but highlightedSquares comes in.
  // The backend clears highlightSquares when nothing is selected.
  
  useEffect(() => {
    prevHistoryLengthRef.current = historyLength;

    // If there is a capture in the last move, and it's a new move, we orchestrate it!
    if (isNewMove && lastMove && lastMove.captured) {
      // Find the attacking piece and the captured piece
      // Target square is algebraic form, let's parse it
      const toFiles = 'abcdefgh';
      const toRank = parseInt(lastMove.to[1], 10);
      const toFileObj = toFiles.indexOf(lastMove.to[0]);
      
      const fromFiles = 'abcdefgh';
      const fromRank = parseInt(lastMove.from[1], 10);
      const fromFileObj = fromFiles.indexOf(lastMove.from[0]);

      // Handle orientation
      const getCoords = (fileIdx: number, rankStr: number) => {
        let col = fileIdx;
        let row = 8 - rankStr;
        if (orientation === 'black') {
          col = 7 - col;
          row = 7 - row;
        }
        return { x: col * squareSize, y: row * squareSize };
      };

      const attackerCoords = getCoords(fromFileObj, fromRank);
      let targetFileIdx = toFileObj;
      let targetRank = toRank;

      // En passant correction: target pawn is actually behind!
      if (lastMove.flags.includes('e')) {
         targetRank = lastMove.color === 'w' ? toRank - 1 : toRank + 1;
      }
      const targetCoords = getCoords(targetFileIdx, targetRank);
      
      const COLOR_NAMES: Record<string, string> = { w: 'white', b: 'black' };
      const pieceColor = COLOR_NAMES[lastMove.color];
      
      const finalAttacker = pieces.find(p => !p.isCaptured && p.color === pieceColor && p.currentSquare === (8 - toRank) * 8 + toFileObj);
      const finalTarget = pieces.find(p => p.isCaptured && p.currentSquare === (8 - targetRank) * 8 + targetFileIdx);
      
      if (finalAttacker && finalTarget) {
        const attackerElement = document.getElementById(finalAttacker.id);
        const targetElement = document.getElementById(finalTarget.id);
        const boardElement = boardRef.current;
        
        if (attackerElement && targetElement && boardElement) {
           attackerElement.classList.add('is-striking');
           playCaptureSequence(
              attackerElement,
              targetElement,
              boardElement,
              getCoords(toFileObj, toRank).x,
              getCoords(toFileObj, toRank).y,
              attackerCoords.x,
              attackerCoords.y
           );
           
           // Remove class after animation finishes (duration of strike is ~500ms)
           setTimeout(() => {
             if (attackerElement) attackerElement.classList.remove('is-striking');
           }, 800);
        }
      }
    }
  }, [historyLength, isNewMove, lastMove, pieces, orientation, squareSize]);

  const displayIndices = orientation === 'black' 
    ? Array.from({ length: 64 }, (_, i) => 63 - i)
    : Array.from({ length: 64 }, (_, i) => i);

  // The Board size needs to be passed dynamically via CSS variables contextually
  const containerStyle = {
    '--board-size': `${squareSize * 8}px`,
    '--square-size': `${squareSize}px`,
  } as React.CSSProperties;

  return (
    <div className="chess-container group board-neon-border" style={containerStyle} ref={boardRef}>
      {/* Outer ambient glow */}
      <div className="glow-backdrop" />
      <div className="board-wrapper" />

      <div className="board-layer">
        {displayIndices.map((index) => {
          const row = Math.floor(index / 8);
          const col = index % 8;
          const isLight = (row + col) % 2 === 0;
          const isHighlighted = highlightSquares.includes(index);
          const isPremovePath = (premoves && premoves.length > 0)
            ? premoves.some(p => p.fromIndex === index || p.toIndex === index)
            : premoveSquares.includes(index);
          const targetPiece = position ? position[index] : null;
          const hasPiece = targetPiece !== null;
          const isCapturable = hasPiece && targetPiece.type !== 'k';

          let highlightClass = '';
          if (isPremovePath) {
            highlightClass = 'square-premove-bg';
          } else if (isHighlighted) {
            if (isPremovePhase) {
               highlightClass = isCapturable ? 'square-premove-capture' : 'square-premove';
            } else {
               highlightClass = isCapturable ? 'square-highlight-capture' : 'square-highlight';
            }
          }

          const squareClass = [
            'square',
            isLight ? 'square-light' : 'square-dark',
            highlightClass
          ].filter(Boolean).join(' ');

          const squareStyle: React.CSSProperties = {
            transition: 'background-color 0.15s ease',
            position: 'relative',
          };

          const rankNum = 8 - row;
          const fileChar = String.fromCharCode(97 + col);
          const renderIndex = displayIndices.indexOf(index);
          const isVisualBottom = renderIndex >= 56;
          const isVisualLeft = renderIndex % 8 === 0;

          return (
            <div
              key={`sq-${index}`}
              className={squareClass}
              style={squareStyle}
              onClick={() => onSquareClick?.(index, position ? position[index] : null)}
              aria-label={`Square ${fileChar}${rankNum}`}
            >
              {isVisualLeft && (
                <span className="absolute top-1 left-1.5 text-[10px] md:text-[11px] font-mono font-bold text-white/40 pointer-events-none select-none z-10 leading-none">
                  {rankNum}
                </span>
              )}
              {isVisualBottom && (
                <span className="absolute bottom-1 right-1.5 text-[10px] md:text-[11px] font-mono font-bold text-white/40 pointer-events-none select-none z-10 leading-none">
                  {fileChar}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="action-layer">
        {pieces.map((piece) => {
          let logicalSquare = piece.currentSquare;
          let isGhost = false;
          let hideCaptured = false;

          if (premoves && premoves.length > 0) {
            for (const pm of premoves) {
              if (logicalSquare === pm.fromIndex && !piece.isCaptured && !hideCaptured) {
                logicalSquare = pm.toIndex;
                isGhost = true;
              } else if (logicalSquare === pm.toIndex && !piece.isCaptured) {
                hideCaptured = true;
              }
              // Castling premove visual for the rook
              if (piece.type === 'r') {
                if (pm.fromIndex === 60 && pm.toIndex === 62 && logicalSquare === 63) { logicalSquare = 61; isGhost = true; } // White O-O
                else if (pm.fromIndex === 60 && pm.toIndex === 58 && logicalSquare === 56) { logicalSquare = 59; isGhost = true; } // White O-O-O
                else if (pm.fromIndex === 4 && pm.toIndex === 6 && logicalSquare === 7) { logicalSquare = 5; isGhost = true; } // Black O-O
                else if (pm.fromIndex === 4 && pm.toIndex === 2 && logicalSquare === 0) { logicalSquare = 3; isGhost = true; } // Black O-O-O
              }
            }
          } else if (premoveSquares && premoveSquares.length === 2) {
            if (logicalSquare === premoveSquares[0] && !piece.isCaptured) {
              logicalSquare = premoveSquares[1];
              isGhost = true;
            } else if (logicalSquare === premoveSquares[1] && !piece.isCaptured && position && position[premoveSquares[0]] && position[premoveSquares[0]].color !== piece.color) {
              hideCaptured = true;
            }
          }
          
          if (hideCaptured) return null;

          // Translate 0-63 index to row/col
          let row = Math.floor(logicalSquare / 8);
          let col = logicalSquare % 8;

          if (orientation === 'black') {
            row = 7 - row;
            col = 7 - col;
          }

          const currentX = col * squareSize;
          const currentY = row * squareSize;

          // Check if piece is in highlightSquares to conditionally add selected style
          // BUT wait, highlightSquares is primarily legal move TARGETS.
          // The selected square is the one that has a piece on it that we highlighted.
          // Wait, 'useChessGame' selectedIndex state is lost here, but highlightSquares are passed.
          // For now we just pass 'false' for selected as the highlight on square works.
          
      // Attacker id
      let attackerIdForClass = '';
      let targetIdForClass = '';
      const toRank = lastMove ? parseInt(lastMove.to[1], 10) : 0;
      const toFileObj = lastMove ? 'abcdefgh'.indexOf(lastMove.to[0]) : 0;
      if (isNewMove && lastMove && lastMove.captured) {
         const PIECE_TYPES: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
         const COLOR_NAMES: Record<string, string> = { w: 'white', b: 'black' };
         const pieceColor = COLOR_NAMES[lastMove.color];
         
         const finalAttacker = pieces.find(p => !p.isCaptured && p.color === pieceColor && p.currentSquare === (8 - toRank) * 8 + toFileObj);
         if (finalAttacker) attackerIdForClass = finalAttacker.id;
         
         let targetRank = toRank;
         let targetFileIdx = toFileObj;
         if (lastMove.flags.includes('e')) {
            targetRank = lastMove.color === 'w' ? toRank - 1 : toRank + 1;
         }
         const finalTarget = pieces.find(p => p.isCaptured && p.currentSquare === (8 - targetRank) * 8 + targetFileIdx);
         if (finalTarget) targetIdForClass = finalTarget.id;
      }
      
      return (
        <ChessPiece
          key={piece.id}
          id={piece.id}
          icon={ICON[piece.type]}
          color={piece.color}
          currentX={currentX}
          currentY={currentY}
          isCaptured={piece.isCaptured}
          isStriking={piece.id === attackerIdForClass}
          isTarget={piece.id === targetIdForClass}
          size={Math.round(squareSize * 0.56)}
          opacity={isGhost ? 0.4 : 1}
          onClick={() => {
            onSquareClick?.(logicalSquare, { type: piece.type, color: piece.color });
          }}
        />
      );
        })}
      </div>

      <CombatTextOverlay lastMove={lastMove} orientation={orientation} squareSize={squareSize} pieces={pieces} historyLength={historyLength} />

      {pendingPromotion && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--surface)',
            padding: 16,
            borderRadius: 8,
            border: '2px solid var(--primary)',
            boxShadow: '0 0 20px rgba(0, 255, 209, 0.4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            alignItems: 'center',
          }}>
            <h3 style={{ color: '#fff', fontSize: 18, fontWeight: 600, margin: 0, fontFamily: 'var(--font-heading)'}}>Promote Pawn</h3>
            <div style={{ display: 'flex', gap: 12 }}>
              {['q', 'r', 'n', 'b'].map(p => {
                const typeMap: any = { q: 'queen', r: 'rook', n: 'knight', b: 'bishop' };
                const pieceType = typeMap[p];
                return (
                  <div
                    key={p}
                    onClick={() => resolvePromotion?.(p)}
                    className="promotion-piece-btn"
                    style={{
                      width: squareSize * 1.2,
                      height: squareSize * 1.2,
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 8,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'all 0.2s',
                    }}
                  >
                    <span
                      className={`material-symbols-outlined neon-glow-${pendingPromotion.color === 'w' ? 'white' : 'black'}`}
                      style={{
                        fontSize: `${squareSize * 0.8}px`,
                        fontVariationSettings: "'FILL' 1",
                        color: pendingPromotion.color === 'w' ? '#fff' : '#000',
                        textShadow: pendingPromotion.color === 'b' ? '0 0 10px rgba(255,0,0,0.8)' : undefined
                      }}
                    >
                      {ICON[pieceType]}
                    </span>
                  </div>
                );
              })}
            </div>
            <button
               onClick={() => resolvePromotion?.('')}
               style={{
                 background: 'transparent',
                 border: '1px solid rgba(255,255,255,0.2)',
                 color: '#aaa',
                 padding: '6px 12px',
                 borderRadius: 6,
                 cursor: 'pointer'
               }}
            >
               Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export { DEFAULT_POSITION };
export default ChessBoard;
