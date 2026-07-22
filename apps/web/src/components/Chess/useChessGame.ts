import { useState, useCallback, useEffect } from 'react';
import { Chess } from 'chess.js';
import {
  chessToPosition,
  indexToAlgebraic,
  algebraicToIndex,
  uciToMoveObj,
  moveToUci,
  getGameResult,
  getCapturedPieces,
  getMaterialAdvantage,
  COLOR_TO_NAME,
} from './gameUtils';
import { chessAudio } from './audio';

export function playSoundForMove(move: any) {
  if (move.san.includes('#')) {
    chessAudio.playCheckmate();
  } else if (move.promotion) {
    chessAudio.playPromotion(move.color);
  } else if (move.san.startsWith('O-O')) {
    chessAudio.playCastle(move.color);
  } else if (move.san.includes('+')) {
    chessAudio.playCheck(move.color);
  } else if (move.captured) {
    chessAudio.playCapture(move.color);
  } else {
    chessAudio.playMove(move.color);
  }
}

function getProjectedChess(
  baseChess: Chess, 
  premoves: Array<{fromIndex: number, toIndex: number, promotion?: string}>,
  targetPlayerColor: string
) {
  const proj = new Chess(baseChess.fen());
  const targetPlayerChar = targetPlayerColor === 'white' ? 'w' : 'b';
  
  for (const pm of premoves) {
    const from = indexToAlgebraic(pm.fromIndex);
    const to = indexToAlgebraic(pm.toIndex);
    
    const currentTurnChar = proj.turn();
    if (currentTurnChar !== targetPlayerChar) {
      const tokens = proj.fen().split(' ');
      tokens[1] = targetPlayerChar;
      tokens[3] = '-';
      try {
        proj.load(tokens.join(' '));
      } catch (e) {
        break;
      }
    }
    
    try {
      proj.move({
        from,
        to,
        ...(pm.promotion ? { promotion: pm.promotion } : {})
      } as any);
    } catch (e) {
      break;
    }
  }
  
  // Ensure the final state turn matches targetPlayerChar if we want to query legal moves for that player
  if (proj.turn() !== targetPlayerChar) {
    const tokens = proj.fen().split(' ');
    tokens[1] = targetPlayerChar;
    tokens[3] = '-';
    try {
      proj.load(tokens.join(' '));
    } catch (e) {
      // ignore
    }
  }
  
  return proj;
}

const GAME_OVER_STATUSES = new Set(['checkmate', 'stalemate', 'draw']);

export function useChessGame({ 
  onMoveMade,
  playerColor,
}: { 
  onMoveMade?: (move: any, currentFen: string, uci: string) => void,
  playerColor?: string,
} = {}) {
  const [chess] = useState(() => new Chess());

  const [position,          setPosition]          = useState(() => chessToPosition(chess));
  const [selectedIndex,     setSelectedIndex]      = useState<number | null>(null);
  const [legalMoveIndices,  setLegalMoveIndices]   = useState<number[]>([]);
  const [turn,              setTurn]               = useState('white');
  const [gameResult,        setGameResult]         = useState<any>({ status: 'playing', winner: null, message: null });
  const [history,           setHistory]            = useState<any[]>([]);
  const [capturedPieces,    setCapturedPieces]     = useState({ white: [], black: [] });
  const [materialAdvantage, setMaterialAdvantage]  = useState(0);
  const [premoves,          setPremoves]          = useState<Array<{fromIndex: number, toIndex: number, promotion?: string}>>([]);
  const [pendingPromotion,  setPendingPromotion]  = useState<{fromIndex: number, toIndex: number, color: 'w' | 'b', isPremove: boolean} | null>(null);

  const syncState = useCallback(() => {
    const verbose = chess.history({ verbose: true });
    const captured = getCapturedPieces(verbose);

    setPosition(chessToPosition(chess));
    setTurn(COLOR_TO_NAME[chess.turn()]);
    setGameResult(getGameResult(chess));
    setHistory(verbose);
    setCapturedPieces(captured as any);
    setMaterialAdvantage(getMaterialAdvantage(captured));
  }, [chess]);

  const resolvePromotion = useCallback((pieceType: string) => {
    if (!pendingPromotion) return;
    
    const { fromIndex, toIndex, isPremove } = pendingPromotion;
    
    if (isPremove) {
      setPremoves(prev => [
        ...prev,
        {
          fromIndex,
          toIndex,
          promotion: pieceType || 'q'
        }
      ]);
    } else {
      if (pieceType) {
        const from = indexToAlgebraic(fromIndex);
        const to = indexToAlgebraic(toIndex);
        try {
          const move = chess.move({
            from,
            to,
            promotion: pieceType,
          } as any);

          if (move) {
            playSoundForMove(move);
            const uci = moveToUci(move);
            const fenAfterMove = chess.fen();
            onMoveMade?.(move, fenAfterMove, uci);
            syncState();
          }
        } catch (e) {
          // move is invalid
        }
      }
    }
    
    setPendingPromotion(null);
  }, [pendingPromotion, chess, onMoveMade, syncState]);

  const getPremoveColor = useCallback(() => {
    if (playerColor) return playerColor;
    if (premoves.length > 0) {
      const firstFrom = indexToAlgebraic(premoves[0].fromIndex);
      const piece = chess.get(firstFrom as any);
      if (piece) return COLOR_TO_NAME[piece.color];
    }
    if (selectedIndex !== null) {
      const piece = chess.get(indexToAlgebraic(selectedIndex) as any);
      if (piece) return COLOR_TO_NAME[piece.color];
    }
    return chess.turn() === 'w' ? 'black' : 'white';
  }, [chess, playerColor, premoves, selectedIndex]);

  const triggerNextPremove = useCallback(() => {
    if (premoves.length === 0) return;
    const premoveColor = getPremoveColor();
    if (COLOR_TO_NAME[chess.turn()] !== premoveColor) return;
    
    const nextPm = premoves[0];
    const from = indexToAlgebraic(nextPm.fromIndex);
    const to = indexToAlgebraic(nextPm.toIndex);
    const pPromotion = nextPm.promotion;
    
    setTimeout(() => {
      try {
        if (COLOR_TO_NAME[chess.turn()] !== premoveColor) return;
        
        const pMove = chess.move({
          from,
          to,
          ...(pPromotion ? { promotion: pPromotion } : {})
        } as any);
        
        if (pMove) {
          playSoundForMove(pMove);
          setPremoves(prev => prev.slice(1));
          const uci = moveToUci(pMove);
          syncState();
          onMoveMade?.(pMove, chess.fen(), uci);
        } else {
          setPremoves([]);
          syncState();
        }
      } catch (_) {
        setPremoves([]);
        syncState();
      }
    }, 500);
  }, [chess, premoves, getPremoveColor, onMoveMade, syncState]);

  useEffect(() => {
    if (premoves.length > 0) {
      const premoveColor = getPremoveColor();
      if (turn === premoveColor) {
        triggerNextPremove();
      }
    }
  }, [turn, premoves.length, triggerNextPremove, getPremoveColor]);

  const selectSquare = useCallback((index: number) => {
    if (GAME_OVER_STATUSES.has(gameResult.status)) return { action: 'none' };

    const premoveColor = getPremoveColor();
    const projChess = getProjectedChess(chess, premoves, premoveColor);

    const square       = indexToAlgebraic(index);
    const piece        = projChess.get(square as any);
    const currentSide  = COLOR_TO_NAME[chess.turn()];

    // Determine the color of the piece the user is interacting with
    let interactingColor: string | null = null;
    if (selectedIndex !== null) {
      const selectedPiece = projChess.get(indexToAlgebraic(selectedIndex) as any);
      if (selectedPiece) {
        interactingColor = COLOR_TO_NAME[selectedPiece.color];
      }
    } else if (piece) {
      interactingColor = COLOR_TO_NAME[piece.color];
    }

    if (!interactingColor) {
      setSelectedIndex(null);
      setLegalMoveIndices([]);
      return { action: 'none' };
    }

    // In online/computer game (playerColor set), restrict interactions to player's color
    if (playerColor && interactingColor !== playerColor) {
      setSelectedIndex(null);
      setLegalMoveIndices([]);
      return { action: 'none' };
    }

    const isPremovePhase = interactingColor !== currentSide;

    if (isPremovePhase) {
      if (piece && COLOR_TO_NAME[piece.color] === interactingColor) {
        setSelectedIndex(index);
        
        let targets: any[] = [];
        try {
          targets = projChess.moves({ square: square as any, verbose: true });
        } catch(e) {
          // fallback
        }
        
        const indices = [];
        for (const m of targets) {
          if (m.captured === 'k') continue; // Don't allow capturing the king
          indices.push(algebraicToIndex(m.to));
          if (m.san === 'O-O') {
            if (m.color === 'w') indices.push(63);
            else indices.push(7);
          } else if (m.san === 'O-O-O') {
            if (m.color === 'w') indices.push(56);
            else indices.push(0);
          }
        }
        
        setLegalMoveIndices(indices);
        return { action: 'select', square };
      }

      if (selectedIndex !== null) {
        if (!legalMoveIndices.includes(index)) {
           setSelectedIndex(null);
           setLegalMoveIndices([]);
           return { action: 'none' };
        }
        
        const from = indexToAlgebraic(selectedIndex);
        const fromPiece = projChess.get(from as any);
        
        let targetIndex = index;
        if (fromPiece?.type === 'k') {
          if (from === 'e1' && index === 63) targetIndex = 62;
          if (from === 'e1' && index === 56) targetIndex = 58;
          if (from === 'e8' && index === 7) targetIndex = 6;
          if (from === 'e8' && index === 0) targetIndex = 2;
        }

        const isPromotion =
          fromPiece?.type === 'p' &&
          ((fromPiece.color === 'w' && targetIndex <= 7) ||
           (fromPiece.color === 'b' && targetIndex >= 56));
        
        if (isPromotion) {
          setPendingPromotion({ fromIndex: selectedIndex, toIndex: targetIndex, color: fromPiece.color as 'w'|'b', isPremove: true });
          setSelectedIndex(null);
          setLegalMoveIndices([]);
          return { action: 'pending-promotion' };
        }
        
        setPremoves(prev => [
          ...prev,
          {
            fromIndex: selectedIndex,
            toIndex: targetIndex,
            promotion: undefined
          }
        ]);
        setSelectedIndex(null);
        setLegalMoveIndices([]);
        return { action: 'premove-set' };
      }
      return { action: 'none' };
    }

    // Normal move phase
    if (piece && COLOR_TO_NAME[piece.color] === currentSide) {
      setSelectedIndex(index);
      const targets = chess.moves({ square: square as any, verbose: true });
      const indices = [];
      for (const m of targets) {
        indices.push(algebraicToIndex(m.to));
        if (m.san === 'O-O') {
          if (m.color === 'w') indices.push(63);
          else indices.push(7);
        } else if (m.san === 'O-O-O') {
          if (m.color === 'w') indices.push(56);
          else indices.push(0);
        }
      }
      setLegalMoveIndices(indices);
      // Clear premove index if user interacts with own pieces during their actual turn
      if (premoves.length > 0 && playerColor) setPremoves([]); 
      return { action: 'select', square };
    }

    if (selectedIndex !== null) {
      const from      = indexToAlgebraic(selectedIndex);
      const fromPiece = chess.get(from as any);

      if (!legalMoveIndices.includes(index)) {
        setSelectedIndex(null);
        setLegalMoveIndices([]);
        return { action: 'deselect' };
      }

      let targetIndex = index;
      if (fromPiece?.type === 'k') {
        if (from === 'e1' && index === 63) targetIndex = 62;
        if (from === 'e1' && index === 56) targetIndex = 58;
        if (from === 'e8' && index === 7) targetIndex = 6;
        if (from === 'e8' && index === 0) targetIndex = 2;
      }

      const isPromotion =
        fromPiece?.type === 'p' &&
        ((fromPiece.color === 'w' && targetIndex <= 7) ||
         (fromPiece.color === 'b' && targetIndex >= 56));

      if (isPromotion) {
        setPendingPromotion({ fromIndex: selectedIndex, toIndex: targetIndex, color: fromPiece.color as 'w'|'b', isPremove: false });
        setSelectedIndex(null);
        setLegalMoveIndices([]);
        return { action: 'pending-promotion' };
      }

      try {
        const targetSquare = indexToAlgebraic(targetIndex);
        const move = chess.move({
          from,
          to:   targetSquare,
        } as any);

        if (move) {
          playSoundForMove(move);
          setSelectedIndex(null);
          setLegalMoveIndices([]);
          
          const uci = moveToUci(move);
          const fenAfterMove = chess.fen();
          onMoveMade?.(move, fenAfterMove, uci);

          syncState();
          return { action: 'move', move, uci, fen: chess.fen() };
        }
      } catch (_) {
      }

      setSelectedIndex(null);
      setLegalMoveIndices([]);
      return { action: 'deselect' };
    }

    return { action: 'none' };
  }, [chess, gameResult.status, selectedIndex, legalMoveIndices, playerColor, premoves, getPremoveColor, onMoveMade, syncState]);

  const applyExternalMove = useCallback((uciMove: string) => {
    try {
      const move = chess.move(uciToMoveObj(uciMove) as any);
      if (move) {
        playSoundForMove(move);
        setSelectedIndex(null);
        setLegalMoveIndices([]);
        syncState();
        return move;
      }
    } catch (e) {
      console.error('[useChessGame] Invalid external move:', uciMove, e);
    }
    return null;
  }, [chess, syncState]);

  const resetGame = useCallback(() => {
    chess.reset();
    setSelectedIndex(null);
    setLegalMoveIndices([]);
    setPremoves([]);
    syncState();
  }, [chess, syncState]);

  const loadFen = useCallback((fen: string) => {
    chess.load(fen);
    setSelectedIndex(null);
    setLegalMoveIndices([]);
    setPremoves([]);
    syncState();
  }, [chess, syncState]);

  const undoMove = useCallback(() => {
    if (premoves.length > 0) {
      setPremoves(prev => prev.slice(0, -1));
      setSelectedIndex(null);
      setLegalMoveIndices([]);
      return null;
    }
    const move = chess.undo();
    if (move) {
      chessAudio.playMove(move.color);
      setSelectedIndex(null);
      setLegalMoveIndices([]);
      syncState();
    }
    return move;
  }, [chess, premoves, syncState]);

  return {
    position,
    selectedIndex,
    legalMoveIndices,
    turn,
    gameResult,
    history,
    capturedPieces,
    materialAdvantage,
    fen: chess.fen(),
    isPremovePhase: (() => {
      if (selectedIndex !== null) {
        const projChess = getProjectedChess(chess, premoves, getPremoveColor());
        const piece = projChess.get(indexToAlgebraic(selectedIndex) as any);
        if (piece) return COLOR_TO_NAME[piece.color] !== COLOR_TO_NAME[chess.turn()];
      }
      return playerColor ? COLOR_TO_NAME[chess.turn()] !== playerColor : false;
    })(),
    selectSquare,
    applyExternalMove,
    resetGame,
    loadFen,
    undoMove,
    premove: premoves[0] || null,
    premoves,
    pendingPromotion,
    resolvePromotion,
    chess,
  };
}
