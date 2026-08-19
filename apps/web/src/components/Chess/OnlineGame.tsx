import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChessKing, ChessQueen, ChessRook, ChessKnight, ChessBishop, ChessPawn } from 'lucide-react';
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

function ConnectionPill({ status }: any) {
  const map: any = {
    connected:    { color: '#4ade80', label: 'Connected'    },
    connecting:   { color: '#facc15', label: 'Connecting…'  },
    waiting:      { color: '#facc15', label: 'Waiting for opponent…' },
    disconnected: { color: '#f87171', label: 'Disconnected' },
  };
  const { color, label } = map[status] ?? map.disconnected;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: color,
        boxShadow: `0 0 6px ${color}`,
        flexShrink: 0,
      }} />
      <span style={{ fontSize: 12, color, fontFamily: 'var(--font-body)' }}>
        {label}
      </span>
    </div>
  );
}




// Friendly captions for the server's gameEnded `reason` codes. Unknown codes
// fall through as-is (better raw than silent).
const SERVER_END_REASONS: Record<string, string> = {
  resign:       'Opponent resigned',
  disconnect:   'Opponent disconnected',
  draw_agreed:  'Draw agreed',
  checkmate:    'Checkmate',
  reported:     'Match complete',
  conflict:     'Conflicting reports — game voided',
};

/**
 * Winner-aware caption. The bare map above is what BOTH clients receive —
 * but "Opponent resigned" is only true on the survivor's screen (the
 * resigner gets the same event). The forfeit story is told only to the
 * player it happened TO; everyone else keeps the neutral caption.
 */
function serverEndCaption(
  reason: string,
  winner: 'white' | 'black' | 'draw',
  playerColor: 'white' | 'black'
): string {
  const iWon = winner !== 'draw' && winner === playerColor;
  if (reason === 'disconnect' && iWon) {
    return 'Opponent left the game — you win by forfeit';
  }
  if (reason === 'resign') {
    return iWon ? 'Opponent resigned — you win' : 'You resigned';
  }
  return SERVER_END_REASONS[reason] ?? reason;
}

export default function OnlineGame({
  playerColor      = 'white',
  onSendMove,
  externalMove     = null,
  connectionStatus = 'connecting',
  gameId,
  opponentName,
  playerName,
  profile,
  onGameEnd,
  serverGameEnd    = null, // { winner: 'white'|'black'|'draw', reason } | null
  onRematchRequest,
  onReturnToLobby
}: any) {
  const opponentColor = playerColor === 'white' ? 'black' : 'white';

  const lastAppliedMove = useRef<string | null>(null);

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
    playerColor,
    onMoveMade: (_move, currentFen, uci) => {
      if (turn === playerColor) {
        onSendMove?.(uci, currentFen);
      }
    },
  });

  useEffect(() => {
    if (['checkmate', 'stalemate', 'draw'].includes(gameResult.status)) {
      onGameEnd?.({ result: gameResult, history, fen });
    }
  }, [gameResult.status, history, fen, onGameEnd]);

  useEffect(() => {
    if (!externalMove) return;
    if (externalMove === lastAppliedMove.current) return; 
    if (turn !== opponentColor) return;                   

    const applied = applyExternalMove(externalMove);
    if (applied) lastAppliedMove.current = externalMove;
  }, [externalMove, applyExternalMove, opponentColor, turn]); 

  const handleSquareClick = useCallback((index: number) => {
    if (connectionStatus !== 'connected') return;
    selectSquare(index);
  }, [connectionStatus, selectSquare]);

  const handleRematch = useCallback(() => {
    lastAppliedMove.current = null;
    resetGame();
    onRematchRequest?.();
  }, [resetGame, onRematchRequest]);

  // ── Server-declared game end ────────────────────────────────────────────────
  // Local chess.js already detects mate/stalemate/draw; the server event fills
  // the gaps only IT can see (resign, disconnect, agreed draw). When the local
  // result is already terminal we keep it (richer message); otherwise we
  // synthesize a GameOverOverlay-shaped result from the server payload.
  const localIsOver = ['checkmate', 'stalemate', 'draw'].includes(gameResult.status);
  const usingServerEnd = !localIsOver && !!serverGameEnd;
  const displayResult = usingServerEnd
    ? {
        status:  serverGameEnd.winner === 'draw' ? 'draw' : 'checkmate',
        winner:  serverGameEnd.winner === 'draw' ? null : serverGameEnd.winner,
        message: serverEndCaption(serverGameEnd.reason, serverGameEnd.winner, playerColor),
      }
    : gameResult;

  const playerCaptured   = playerColor   === 'white' ? capturedPieces.white : capturedPieces.black;
  const opponentCaptured = opponentColor === 'white' ? capturedPieces.white : capturedPieces.black;
  const playerAdv   = playerColor   === 'white' ?  materialAdvantage : -materialAdvantage;
  const opponentAdv = opponentColor === 'white' ?  materialAdvantage : -materialAdvantage;

  const isWaiting = connectionStatus === 'waiting';

  return (
    <div style={styles.root as any}>
      <div style={{ position: 'relative' }}>

        {isWaiting && (
          <div style={styles.waitingOverlay as any}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#00FFD1', fontFamily: 'var(--font-body)' }}>
              Waiting for opponent…
            </div>
            {gameId && (
              <div style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', textAlign: 'center' }}>
                Share room code{' '}
                <span style={{ color: '#00FFD1', fontFamily: 'monospace', fontWeight: 700 }}>{gameId}</span>
                {' '}with a friend
              </div>
            )}
          </div>
        )}

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
            background: 'linear-gradient(135deg, #00FFD1 0%, #00bda0 100%)',
            border: '2px solid rgba(0,255,209,0.8)',
            boxShadow: '0 0 10px rgba(0,255,209,0.4)',
            backgroundImage: `url("https://api.dicebear.com/7.x/avataaars/svg?seed=${opponentName || 'Opponent'}")`,
            backgroundSize: 'cover'
          }} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <span style={{
              fontSize: 15, fontWeight: 700,
              color: '#FFFFFF',
              fontFamily: 'var(--font-body)',
              lineHeight: 1,
            }}>
              {opponentName || 'Opponent'}
            </span>
            <div style={{ marginTop: 0, display: 'flex', alignItems: 'center', minHeight: 20 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {[...opponentCaptured].sort((a, b) => PIECE_ORDER.indexOf(a) - PIECE_ORDER.indexOf(b)).map((p, i) => (
                  <span key={i} title={p} style={{ display: 'inline-flex', alignItems: 'center' }}>
                    <CapturedPiece type={p} color={opponentColor} />
                  </span>
                ))}
              </span>
              {opponentAdv > 0 && (
                <span style={{ fontSize: 11, color: '#FF0055', marginLeft: 6 }}>+{opponentAdv}</span>
              )}
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
          orientation={playerColor}
        />
        <GameOverOverlay
          gameResult={displayResult}
          playerColor={playerColor}
          // No chess rematch protocol exists server-side yet, so a
          // server-declared end (resign/disconnect) offers the lobby instead.
          onRematch={usingServerEnd ? onReturnToLobby : handleRematch}
          rematchText={usingServerEnd ? 'Return to Lobby' : 'Request Rematch'}
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
              {profile?.name || playerName || 'You'}
            </span>
            <div style={{ marginTop: 0, display: 'flex', alignItems: 'center', minHeight: 20 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {[...playerCaptured].sort((a, b) => PIECE_ORDER.indexOf(a) - PIECE_ORDER.indexOf(b)).map((p, i) => (
                  <span key={i} title={p} style={{ display: 'inline-flex', alignItems: 'center' }}>
                    <CapturedPiece type={p} color={playerColor} />
                  </span>
                ))}
              </span>
              {playerAdv > 0 && (
                <span style={{ fontSize: 11, color: '#00FFD1', marginLeft: 6 }}>+{playerAdv}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={styles.sidebar as any}>
        <MoveHistoryPanel 
          history={history} 
          onUndo={undefined} // Usually online games don't let you directly undo without server
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
  statusLine: {
    fontSize:      13,
    color:         'var(--color-on-surface-variant)',
    textAlign:     'center',
    fontStyle:     'italic',
  },
  playingAs: {
    margin:    '4px 0 0',
    fontSize:  12,
    color:     'var(--color-on-surface-variant)',
    textAlign: 'center',
  },
  waitingOverlay: {
    position:       'absolute',
    inset:          0,
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    background:     'rgba(4, 16, 16, 0.7)',
    backdropFilter: 'blur(4px)',
    zIndex:         10,
    gap:            12,
    borderRadius:   2,
  },
};
