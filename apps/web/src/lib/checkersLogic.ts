export type Player = 1 | 2; // 1: Dark (Neon Gold), 2: Cyan
export type PieceType = 0 | 1 | 2 | 11 | 12; // 0: empty, 1: P1, 2: P2, 11: P1 King, 12: P2 King
export type Board = PieceType[][];

export const EMPTY = 0;
export const P1_PIECE = 1;
export const P2_PIECE = 2;
export const P1_KING = 11;
export const P2_KING = 12;

export interface Move {
  from: [number, number];
  to: [number, number];
  capture?: [number, number];
}

export function initBoard(): Board {
  const board: Board = Array(8).fill(null).map(() => Array(8).fill(EMPTY));
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) board[r][c] = P2_PIECE;
    }
  }
  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) board[r][c] = P1_PIECE;
    }
  }
  return board;
}

export function isKing(piece: PieceType): boolean {
  return piece === P1_KING || piece === P2_KING;
}

export function belongsToPlayer(piece: PieceType, player: Player): boolean {
  if (player === 1) return piece === P1_PIECE || piece === P1_KING;
  return piece === P2_PIECE || piece === P2_KING;
}

export function getValidMoves(board: Board, player: Player, from?: [number, number]): Move[] {
  const moves: Move[] = [];
  const captureMoves: Move[] = [];

  const checkSquare = (r: number, c: number) => {
    const piece = board[r][c];
    if (piece === EMPTY || !belongsToPlayer(piece, player)) return;

    const dirs = isKing(piece) 
      ? [[1, 1], [1, -1], [-1, 1], [-1, -1]] 
      : (player === 1 ? [[-1, 1], [-1, -1]] : [[1, 1], [1, -1]]);

    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= 8 || nc < 0 || nc >= 8) continue;

      if (board[nr][nc] === EMPTY) {
        moves.push({ from: [r, c], to: [nr, nc] });
      } else if (!belongsToPlayer(board[nr][nc], player)) {
        const jr = nr + dr;
        const jc = nc + dc;
        if (jr >= 0 && jr < 8 && jc >= 0 && jc < 8 && board[jr][jc] === EMPTY) {
          captureMoves.push({ from: [r, c], to: [jr, jc], capture: [nr, nc] });
        }
      }
    }
  };

  if (from) {
    checkSquare(from[0], from[1]);
  } else {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        checkSquare(r, c);
      }
    }
  }

  // Mandatory capture rule
  return captureMoves.length > 0 ? captureMoves : moves;
}

export function applyMove(board: Board, move: Move): { board: Board; promoted: boolean } {
  const newBoard = board.map(row => [...row]);
  const [fr, fc] = move.from;
  const [tr, tc] = move.to;
  let piece = newBoard[fr][fc];
  let promoted = false;

  newBoard[fr][fc] = EMPTY;
  if (move.capture) {
    newBoard[move.capture[0]][move.capture[1]] = EMPTY;
  }

  if (piece === P1_PIECE && tr === 0) {
    piece = P1_KING;
    promoted = true;
  }
  if (piece === P2_PIECE && tr === 7) {
    piece = P2_KING;
    promoted = true;
  }

  newBoard[tr][tc] = piece;
  return { board: newBoard, promoted };
}

export function isWin(board: Board, player: Player): boolean {
  const opponent = player === 1 ? 2 : 1;
  for (let r = 0; r < 8; r++){
    for (let c = 0; c < 8; c++) {
      if (belongsToPlayer(board[r][c], opponent)) return false;
    }
  }
  return true;
}
