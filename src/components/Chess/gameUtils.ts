export const TYPE_TO_NAME: Record<string, string>  = { p: 'pawn', r: 'rook', n: 'knight', b: 'bishop', q: 'queen', k: 'king' };
export const NAME_TO_TYPE: Record<string, string>  = Object.fromEntries(Object.entries(TYPE_TO_NAME).map(([k, v]) => [v, k]));
export const COLOR_TO_NAME: Record<string, string> = { w: 'white', b: 'black' };
export const NAME_TO_COLOR: Record<string, string> = { white: 'w', black: 'b' };

export function indexToAlgebraic(index: number) {
  const file = String.fromCharCode(97 + (index % 8)); // a–h
  const rank = 8 - Math.floor(index / 8);             // 8–1
  return `${file}${rank}`;
}

export function algebraicToIndex(square: string) {
  const file = square.charCodeAt(0) - 97;  // 0–7
  const rank = parseInt(square[1], 10);    // 1–8
  return (8 - rank) * 8 + file;
}

export function chessToPosition(chess: any) {
  const board = chess.board(); 
  const position = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = board[row][col];
      position.push(
        sq
          ? { type: TYPE_TO_NAME[sq.type], color: COLOR_TO_NAME[sq.color] }
          : null
      );
    }
  }
  return position;
}

export function uciToMoveObj(uci: string) {
  return {
    from: uci.slice(0, 2),
    to:   uci.slice(2, 4),
    ...(uci[4] ? { promotion: uci[4] } : {}),
  };
}

export function moveToUci(move: any) {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

export function getGameResult(chess: any) {
  if (chess.isCheckmate()) {
    const winner = chess.turn() === 'w' ? 'black' : 'white';
    return {
      status:  'checkmate',
      winner,
      message: `${winner.charAt(0).toUpperCase() + winner.slice(1)} wins by checkmate`,
    };
  }
  if (chess.isStalemate())
    return { status: 'stalemate',  winner: null, message: 'Draw — stalemate' };
  if (chess.isThreefoldRepetition())
    return { status: 'draw',       winner: null, message: 'Draw — threefold repetition' };
  if (chess.isInsufficientMaterial())
    return { status: 'draw',       winner: null, message: 'Draw — insufficient material' };
  if (chess.isDraw())
    return { status: 'draw',       winner: null, message: 'Draw — 50-move rule' };
  if (chess.inCheck())
    return { status: 'check',      winner: null, message: 'Check!' };

  return { status: 'playing', winner: null, message: null };
}

export function getCapturedPieces(history: any[]) {
  const captured: { white: string[], black: string[] } = { white: [], black: [] };
  for (const move of history) {
    if (move.captured) {
      const capturingColor = move.color === 'w' ? 'white' : 'black';
      captured[capturingColor].push(TYPE_TO_NAME[move.captured]);
    }
  }
  return captured;
}

const PIECE_VALUES: Record<string, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

export function getMaterialAdvantage(capturedPieces: { white: string[], black: string[] }) {
  const sum = (pieces: string[]) => pieces.reduce((acc, p) => acc + (PIECE_VALUES[p] ?? 0), 0);
  return sum(capturedPieces.white) - sum(capturedPieces.black);
}
