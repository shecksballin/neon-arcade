import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChessKing, ChessQueen, ChessRook, ChessKnight, ChessBishop, ChessPawn } from 'lucide-react';
import ChessBoard from './ChessBoard';
import { useChessGame } from './useChessGame';
import { GameOverOverlay } from './GameOverOverlay';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
import { MoveHistoryPanel } from './MoveHistoryPanel';
import { useNeonBucks } from '../../NeonBucksStore';
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

function StatusBadge({ gameResult, turn, computerColor, isThinking }: any) {
  if (gameResult.status === 'checkmate')
    return <span style={badge('#00FFD1', '#000') as any}>{gameResult.message}</span>;
  if (gameResult.status === 'stalemate' || gameResult.status === 'draw')
    return <span style={badge('#b9cbc3', '#0a1a1a') as any}>{gameResult.message}</span>;
  if (isThinking)
    return <span style={badge('#facc15', '#000') as any}>Engine thinking…</span>;
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





export default function ComputerGame({
  onRequestComputerMove,
  playerColor      = 'white',
  initialDifficulty = 10,
  onGameEnd,
  profile,
  onReturnToLobby,
  wagerAmount = 0
}: any) {
  const [difficulty,   setDifficulty]  = useState(initialDifficulty);
  const [isThinking,   setIsThinking]  = useState(false);
  const computerColor = playerColor === 'white' ? 'black' : 'white';
  const { win } = useNeonBucks();

  const pendingComputer = useRef(false);

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
    applyExternalMove,
    resetGame,
    undoMove,
    premove,
    premoves,
    isPremovePhase,
    pendingPromotion,
    resolvePromotion,
  } = useChessGame({
    onMoveMade: () => {},
    playerColor,
  });

  const handleUndo = useCallback(() => {
    undoMove(); // Undo computer's move
    undoMove(); // Undo our move
  }, [undoMove]);

  useEffect(() => {
    if (['checkmate', 'stalemate', 'draw'].includes(gameResult.status)) {
      onGameEnd?.({ result: gameResult, history, fen });
      
      // Pay out if won against computer
      if (gameResult.status === 'checkmate') {
        const winnerColor = gameResult.winner;
        if (winnerColor === playerColor && wagerAmount > 0) {
          win(wagerAmount * 2);
        }
      } else if ((gameResult.status === 'stalemate' || gameResult.status === 'draw') && wagerAmount > 0) {
        win(wagerAmount); // draw returns money
      }
    }
  }, [gameResult.status, gameResult.winner, onGameEnd, history, fen, playerColor, wagerAmount, win]);

  useEffect(() => {
    const gameOver = ['checkmate', 'stalemate', 'draw'].includes(gameResult.status);
    const isComputerTurn = turn === computerColor;

    if (!isComputerTurn || gameOver || pendingComputer.current) return;
    if (!onRequestComputerMove) return;

    pendingComputer.current = true;
    setIsThinking(true);

    onRequestComputerMove(fen, difficulty)
      .then((uci: string) => {
        if (uci) applyExternalMove(uci);
      })
      .catch((err: any) => {
        console.error('[ComputerGame] Engine error:', err);
      })
      .finally(() => {
        setIsThinking(false);
        pendingComputer.current = false;
      });
  }, [turn, gameResult.status, onRequestComputerMove, difficulty, fen, applyExternalMove, computerColor]);

  const handleSquareClick = useCallback((index: number) => {
    selectSquare(index);
  }, [selectSquare]);

  const handleRematch = useCallback(() => {
    pendingComputer.current = false;
    resetGame();
  }, [resetGame]);

  const whiteCaptured  = capturedPieces.white;
  const blackCaptured  = capturedPieces.black;
  const whiteAdvantage = materialAdvantage > 0 ? materialAdvantage : 0;
  const blackAdvantage = materialAdvantage < 0 ? -materialAdvantage : 0;

  return (
    <div style={styles.root as any}>
      <div style={{ position: 'relative' }}>
        {/* Opponent Info Top Left */}
        <div style={{ 
          position: 'absolute', 
          top: -70, 
          left: 0, 
          display: 'flex', 
          alignItems: 'center', 
          gap: 12 
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%', flexShrink: 0,
            background: 'linear-gradient(135deg, #FF0055 0%, #b3003b 100%)',
            border: '2px solid rgba(0,255,209,0.8)',
            boxShadow: '0 0 10px rgba(0,255,209,0.4)',
            backgroundImage: 'url("/circlestockfishavatar.png")',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <span style={{
              fontSize: 15, fontWeight: 700,
              color: '#FFFFFF',
              fontFamily: 'var(--font-body)',
              lineHeight: 1,
            }}>
              Stockfish
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
        />
        {['checkmate', 'stalemate', 'draw'].includes(gameResult.status) && (
          <ResultsScreen
            won={gameResult.status === 'checkmate' && gameResult.winner === playerColor}
            stake={wagerAmount}
            winnings={
              gameResult.status === 'checkmate' && gameResult.winner === playerColor
                ? wagerAmount * 2
                : (gameResult.status === 'checkmate' ? 0 : wagerAmount)
            }
            gameMode="Practice"
            onRematch={handleRematch}
            onExit={() => onReturnToLobby?.()}
          />
        )}
        
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
            width: 48, height: 48, borderRadius: '50%', flexShrink: 0,
            background: 'linear-gradient(135deg, #00FFD1 0%, #00bda0 100%)',
            border: '2px solid rgba(0,255,209,0.8)',
            boxShadow: '0 0 10px rgba(0,255,209,0.4)',
            backgroundImage: `url("${profile?.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix'}")`,
            backgroundSize: 'cover'
          }} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <span style={{
              fontSize: 15, fontWeight: 700,
              color: '#FFFFFF',
              fontFamily: 'var(--font-body)',
              lineHeight: 1,
            }}>
              {profile?.name || 'Guest'}
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
          onUndo={handleUndo} 
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
  diffBtn: {
    padding:      '4px 10px',
    background:   'transparent',
    border:       '1px solid rgba(58,74,68,0.6)',
    borderRadius: 4,
    color:        'var(--color-on-surface-variant)',
    fontFamily:   'var(--font-body)',
    fontSize:     12,
    cursor:       'pointer',
    transition:   'all 0.15s ease',
  },
  diffBtnActive: {
    borderColor: '#00FFD1',
    color:       '#00FFD1',
    boxShadow:   '0 0 6px rgba(0,255,209,0.3)',
  },
  playingAs: {
    margin:    '4px 0 0',
    fontSize:  12,
    color:     'var(--color-on-surface-variant)',
    textAlign: 'center',
  },
};
