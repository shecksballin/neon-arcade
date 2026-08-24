import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChessKing, ChessQueen, ChessRook, ChessKnight, ChessBishop, ChessPawn } from 'lucide-react';
import ChessBoard from './ChessBoard';
import { useChessGame } from './useChessGame';
import { GameOverOverlay } from './GameOverOverlay';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
// Practice XP: self-reported award chained as the level-progression overlay.
import { PostGameProgression } from '../common/PostGameProgression';
import { usePracticeXp } from '../../hooks/usePracticeXp';
import { MoveHistoryPanel } from './MoveHistoryPanel';
import { DifficultySelector } from './DifficultySelector';
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
  difficulty       = 9,
  onDifficultyChange,
  onGameEnd,
  profile,
  onReturnToLobby,
  wagerAmount = 0,
  // Exit-guard seam (ChessGame): a bumped nonce ends the round as a
  // resignation loss; round lifecycle + progression-finished report back up.
  forfeitNonce = 0,
  onRoundStateChange,
  onProgressionDone,
}: any) {
  const [isThinking,   setIsThinking]  = useState(false);
  const computerColor = playerColor === 'white' ? 'black' : 'white';
  const { win } = useNeonBucks();

  // A confirmed exit mid-round: the round ends AS A LOSS — the results
  // screen, XP report and progression play out exactly like a checkmate.
  const [forfeited, setForfeited] = useState(false);

  const pendingComputer = useRef(false);
  // Practice XP — self-reported award, chained as the progression overlay.
  const { practiceProgression, armRound, reportRound, clearPracticeProgression } =
    usePracticeXp('chess');
  /** Once-per-game guard for the terminal effect (see comment there). */
  const endHandledRef = useRef(false);

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

  // The result the round ACTUALLY ended with: chess.js's verdict, or the
  // synthesized resignation loss when the player forfeited on exit.
  const effectiveResult = forfeited
    ? { status: 'checkmate', winner: computerColor, message: 'You resigned' }
    : gameResult;

  /**
   * Exit-guard seam: a bumped nonce mid-round = confirmed forfeit.
   *
   * EDGE-TRIGGERED, not level-triggered, and that distinction is the whole
   * point of the ref. ChessGame owns the counter and never resets it, so a
   * NEW practice game (this component remounts on every entry) would see a
   * still-positive nonce and forfeit itself before the first move. Seeding
   * the ref with the mounting value means only a genuine increment — a
   * confirm that happened while THIS round was on screen — counts.
   */
  const lastForfeitNonceRef = useRef(forfeitNonce);
  useEffect(() => {
    if (forfeitNonce === lastForfeitNonceRef.current) return;
    lastForfeitNonceRef.current = forfeitNonce;
    if (!['checkmate', 'stalemate', 'draw'].includes(gameResult.status)) {
      setForfeited(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forfeitNonce]);

  const roundOver = ['checkmate', 'stalemate', 'draw'].includes(effectiveResult.status);
  useEffect(() => {
    onRoundStateChange?.(roundOver);
  }, [roundOver, onRoundStateChange]);

  useEffect(() => {
    if (['checkmate', 'stalemate', 'draw'].includes(effectiveResult.status)) {
      // ONCE per game: deps like history/fen keep new identities while the
      // status stays terminal, and an unguarded body re-paid the pot (and
      // would re-report XP) on every such re-run. Reset on rematch below.
      if (endHandledRef.current) return;
      endHandledRef.current = true;
      onGameEnd?.({ result: effectiveResult, history, fen });

      // Pay out if won against computer (a forfeit "checkmate" has the
      // computer as winner, so it pays nothing — the stake is lost).
      if (effectiveResult.status === 'checkmate') {
        const winnerColor = effectiveResult.winner;
        if (winnerColor === playerColor && wagerAmount > 0) {
          win(wagerAmount * 2);
        }
      } else if ((effectiveResult.status === 'stalemate' || effectiveResult.status === 'draw') && wagerAmount > 0) {
        win(wagerAmount); // draw returns money
      }

      // PRACTICE XP — metered self-report; the award chains the same
      // level-progression overlay online chess gets from the socket.
      reportRound({
        result:
          effectiveResult.status === 'checkmate'
            ? effectiveResult.winner === playerColor
              ? 'win'
              : 'loss'
            : 'draw',
      });
    } else {
      endHandledRef.current = false;
    }
  }, [effectiveResult.status, effectiveResult.winner, onGameEnd, history, fen, playerColor, wagerAmount, win, reportRound]);

  useEffect(() => {
    const gameOver =
      forfeited || ['checkmate', 'stalemate', 'draw'].includes(gameResult.status);
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
  }, [turn, gameResult.status, forfeited, onRequestComputerMove, difficulty, fen, applyExternalMove, computerColor]);

  const handleSquareClick = useCallback((index: number) => {
    selectSquare(index);
  }, [selectSquare]);

  const handleRematch = useCallback(() => {
    pendingComputer.current = false;
    // New game: re-arm the once-per-game guards and drop any queued overlay.
    setForfeited(false);
    armRound();
    clearPracticeProgression();
    resetGame();
  }, [resetGame, armRound, clearPracticeProgression]);

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
        {roundOver && (
          <ResultsScreen
            won={effectiveResult.status === 'checkmate' && effectiveResult.winner === playerColor}
            stake={wagerAmount}
            winnings={
              effectiveResult.status === 'checkmate' && effectiveResult.winner === playerColor
                ? wagerAmount * 2
                : (effectiveResult.status === 'checkmate' ? 0 : wagerAmount)
            }
            gameMode="Practice"
            note={forfeited ? 'You left the match — counted as a loss' : null}
            onRematch={handleRematch}
            onExit={() => onReturnToLobby?.()}
          />
        )}

        {/* Level progression, chained after the practice results screen. When
            a forfeit-exit is pending, its close cues the deferred navigation. */}
        <PostGameProgression
          progression={practiceProgression}
          onDone={() => {
            clearPracticeProgression();
            onProgressionDone?.();
          }}
        />
        
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
        <div style={styles.difficultyCard as any}>
          <DifficultySelector
            value={difficulty}
            onChange={(skill: number) => onDifficultyChange?.(skill)}
            title="Engine Difficulty"
            compact
            disabled={isThinking}
          />
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <MoveHistoryPanel
            history={history}
            onUndo={handleUndo}
            onNewGame={handleRematch}
          />
        </div>
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
    display:       'flex',
    flexDirection: 'column',
    gap:           12,
  },
  difficultyCard: {
    background:   '#041010',
    border:       '1px solid rgba(0,255,209,0.2)',
    borderRadius: 8,
    padding:      '12px 10px',
    flexShrink:   0,
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
  },
};
