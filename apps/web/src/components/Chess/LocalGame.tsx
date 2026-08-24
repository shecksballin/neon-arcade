import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Gamepad2, ChessKing, ChessQueen, ChessRook, ChessKnight, ChessBishop, ChessPawn } from 'lucide-react';
import ChessBoard from './ChessBoard';
import { useChessGame } from './useChessGame';
import { GameOverOverlay } from './GameOverOverlay';
import { MoveHistoryPanel } from './MoveHistoryPanel';
import './chess.css';

const PIECE_GLYPHS: Record<string, string> = {
  pawn:   '♟', rook:  '♜', knight: '♞',
  bishop: '♝', queen: '♛', king:   '♚',
};
const PIECE_ORDER = ['queen', 'rook', 'bishop', 'knight', 'pawn'];

const LUCIDE_CHESS_ICONS: Record<string, React.ComponentType<any>> = {
  king: ChessKing,
  queen: ChessQueen,
  rook: ChessRook,
  knight: ChessKnight,
  bishop: ChessBishop,
  pawn: ChessPawn,
};

interface CapturedPieceProps {
  type: string;
  color: 'white' | 'black';
}

function CapturedPiece({ type, color }: CapturedPieceProps) {
  const IconComponent = LUCIDE_CHESS_ICONS[type] || ChessPawn;
  const isWhite = color === 'white';
  
  const style = isWhite
    ? {
        filter: 'none',
        display: 'inline-flex',
        alignItems: 'center',
      }
    : {
        filter: 'none',
        display: 'inline-flex',
        alignItems: 'center',
      };
      
  return (
    <IconComponent
      size={14}
      color={isWhite ? '#000000' : '#FFFFFF'}
      fill={isWhite ? '#000000' : '#FFFFFF'}
      style={style}
    />
  );
}

function StatusBadge({ gameResult, turn }: any) {
  if (gameResult.status === 'checkmate')
    return <span style={badge('#00FFD1', '#000') as any}>{gameResult.message}</span>;
  if (gameResult.status === 'stalemate' || gameResult.status === 'draw')
    return <span style={badge('#b9cbc3', '#0a1a1a') as any}>{gameResult.message}</span>;
  if (gameResult.status === 'check')
    return <span style={badge('#f87171', '#000') as any}>Check!</span>;
  return (
    <span style={badge(turn === 'white' ? '#fffffd' : '#2a3737', turn === 'white' ? '#0a1a1a' : '#00FFD1') as any}>
      {turn.charAt(0).toUpperCase() + turn.slice(1)}'s turn
    </span>
  );
}

function badge(bg: string, fg: string) {
  return {
    display:      'inline-block',
    padding:      '3px 12px',
    borderRadius: '999px',
    fontSize:     '13px',
    fontWeight:   600,
    letterSpacing: '0.04em',
    background:   bg,
    color:        fg,
    fontFamily:   'var(--font-body)',
    transition:   'all 0.2s ease',
  };
}

function CapturedRow({ pieces, label, advantage, color }: any) {
  const sorted = [...pieces].sort(
    (a, b) => PIECE_ORDER.indexOf(a) - PIECE_ORDER.indexOf(b)
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 20 }}>
      {label && <span style={{ fontSize: 11, color: 'var(--color-on-surface-variant)', width: 52, flexShrink: 0 }}>
        {label}
      </span>}
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {sorted.map((p, i) => (
          <span key={i} title={p} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <CapturedPiece type={p} color={color} />
          </span>
        ))}
      </span>
      {Math.abs(advantage) > 0 && (
        <span style={{ fontSize: 12, color: '#00FFD1', marginLeft: 4 }}>
          +{Math.abs(advantage)}
        </span>
      )}
    </div>
  );
}




export default function LocalGame({
  onGameEnd,
  onReturnToLobby,
  // Exit-guard seam: tells ChessGame when the board has a result, so the
  // "leaving loses" confirm stops asking on a finished game.
  onRoundStateChange
}: any) {
  const {
    position,
    legalMoveIndices,
    turn,
    gameResult,
    history,
    capturedPieces,
    materialAdvantage,
    fen,
    selectSquare,
    resetGame,
    undoMove,
    premove,
    premoves,
    isPremovePhase,
    pendingPromotion,
    resolvePromotion,
  } = useChessGame({
    onMoveMade: () => {},
  });

  useEffect(() => {
    if (['checkmate', 'stalemate', 'draw'].includes(gameResult.status)) {
      onGameEnd?.({ result: gameResult, history, fen });
    }
  }, [gameResult.status, onGameEnd, history, fen]);

  const roundOver = ['checkmate', 'stalemate', 'draw'].includes(gameResult.status);
  useEffect(() => {
    onRoundStateChange?.(roundOver);
  }, [roundOver, onRoundStateChange]);

  const handleSquareClick = useCallback((index: number) => {
    selectSquare(index);
  }, [selectSquare]);

  const handleRematch = useCallback(() => {
    resetGame();
  }, [resetGame]);

  const whiteCaptured  = capturedPieces.white;
  const blackCaptured  = capturedPieces.black;
  const whiteAdvantage = materialAdvantage > 0 ? materialAdvantage : 0;
  const blackAdvantage = materialAdvantage < 0 ? -materialAdvantage : 0;

  return (
    <div style={styles.root as any}>
      <div style={{ position: 'relative' }}>
        {/* Black Info Top Left */}
        <div style={{ 
          position: 'absolute', 
          top: -70, 
          left: 0, 
          display: 'flex', 
          alignItems: 'center', 
          gap: 12 
        }}>
          <div style={{
            width: 48, height: 48, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Gamepad2 size={36} color="#FFFFFF" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <span style={{
              fontSize: 15, fontWeight: 700,
              color: '#FFFFFF',
              fontFamily: 'var(--font-body)',
              lineHeight: 1,
            }}>
              P2
            </span>
            <div style={{ marginTop: 0 }}>
              <CapturedRow
                pieces={blackCaptured}
                label=""
                advantage={blackAdvantage}
                color="black"
              />
            </div>
          </div>
        </div>

        <ChessBoard
          position={position}
          history={history}
          highlightSquares={legalMoveIndices}
          premoves={premoves}
          isPremovePhase={isPremovePhase}
          pendingPromotion={pendingPromotion}
          resolvePromotion={resolvePromotion}
          onSquareClick={handleSquareClick}
          orientation="white"
        />
        <GameOverOverlay gameResult={gameResult} onRematch={handleRematch} />

        {/* User Info Bottom Left */}
        <div style={{ 
          position: 'absolute', 
          bottom: -70, 
          left: 0, 
          display: 'flex', 
          alignItems: 'center', 
          gap: 12 
        }}>
          <div style={{
            width: 48, height: 48, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Gamepad2 size={36} color="#FFFFFF" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <span style={{
              fontSize: 15, fontWeight: 700,
              color: '#FFFFFF',
              fontFamily: 'var(--font-body)',
              lineHeight: 1,
            }}>
              P1
            </span>
            <div style={{ marginTop: 0 }}>
              <CapturedRow
                pieces={whiteCaptured}
                label=""
                advantage={whiteAdvantage}
                color="white"
              />
            </div>
          </div>
        </div>
      </div>

      <div style={styles.sidebar as any}>
        <MoveHistoryPanel 
          history={history} 
          onUndo={() => undoMove()} 
          onNewGame={handleRematch}
        />
      </div>
    </div>
  );
}

const styles = {
  root: {
    display:    'flex',
    gap:        24,
    alignItems: 'center',
    fontFamily: 'var(--font-body)',
  },
  sidebar: {
    width:         300,
    height:        600,
    flexShrink:    0,
  },
  sidebarHeader: {
    display:       'flex',
    flexDirection: 'column',
    gap:           8,
  },
  title: {
    margin:      0,
    fontSize:    18,
    fontWeight:  700,
    color:       'var(--color-primary)',
    letterSpacing:'0.02em',
  },
  divider: {
    height:     1,
    background: 'rgba(58,74,68,0.4)',
    margin:     '2px 0',
  },
  sectionLabel: {
    fontSize:      11,
    fontWeight:    600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color:         'var(--color-on-surface-variant)',
    marginBottom:  -4,
  },
  playingAs: {
    margin:    '4px 0 0',
    fontSize:  12,
    color:     'var(--color-on-surface-variant)',
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: '0.1em'
  },
};
