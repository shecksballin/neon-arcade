import { 
  Board, 
  Player, 
  Move, 
  getValidMoves, 
  applyMove, 
  PieceType,
  isKing,
  belongsToPlayer
} from './checkersLogic';

interface Chain {
  moves: Move[];
  board: Board;
}

const PIECE_VALUE = 100;
const KING_VALUE = 175;

const POSITION_BONUS_REGULAR = [
  [0, 1, 0, 1, 0, 1, 0, 1],
  [1, 0, 2, 0, 2, 0, 2, 0],
  [0, 2, 0, 3, 0, 3, 0, 2],
  [2, 0, 3, 0, 4, 0, 3, 0],
  [0, 3, 0, 4, 0, 4, 0, 3],
  [3, 0, 4, 0, 5, 0, 4, 0],
  [0, 4, 0, 5, 0, 5, 0, 4],
  [5, 0, 6, 0, 6, 0, 6, 0],
];

const POSITION_BONUS_KING = [
  [2, 0, 2, 0, 2, 0, 2, 0],
  [0, 3, 0, 3, 0, 3, 0, 2],
  [2, 0, 4, 0, 4, 0, 4, 0],
  [0, 4, 0, 5, 0, 5, 0, 2],
  [2, 0, 5, 0, 5, 0, 4, 0],
  [0, 4, 0, 4, 0, 4, 0, 2],
  [2, 0, 3, 0, 3, 0, 3, 0],
  [2, 0, 2, 0, 2, 0, 2, 0],
];

function scorePiece(piece: PieceType, row: number, col: number, botPlayer: Player): number {
  const isKingPiece = isKing(piece);
  const baseValue = isKingPiece ? KING_VALUE : PIECE_VALUE;

  const isBotPiece = belongsToPlayer(piece, botPlayer);
  const piecesPlayer = isBotPiece ? botPlayer : (botPlayer === 1 ? 2 : 1);
  const tableRow = (piecesPlayer === 1) ? row : (7 - row);
  
  const posBonus = isKingPiece
    ? POSITION_BONUS_KING[tableRow][col]
    : POSITION_BONUS_REGULAR[tableRow][col];

  return baseValue + posBonus;
}

function evaluate(board: Board, botPlayer: Player): number {
  let score = 0;
  const opponent = botPlayer === 1 ? 2 : 1;

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (piece === 0) continue;

      const isBot = belongsToPlayer(piece, botPlayer);
      const pieceScore = scorePiece(piece, row, col, botPlayer);
      score += isBot ? pieceScore : -pieceScore;
    }
  }

  try {
    const botMoves = getValidMoves(board, botPlayer).length;
    const humanMoves = getValidMoves(board, opponent).length;
    score += (botMoves - humanMoves) * 5;
  } catch (e) {}

  return score;
}

export function getAllChains(board: Board, player: Player): Chain[] {
  const firstMoves = getValidMoves(board, player);
  const chains: Chain[] = [];
  for (const move of firstMoves) {
    const result = applyMove(board, move);
    if (move.capture && !result.promoted) {
      const further = getValidMoves(result.board, player, move.to);
      if (further.length > 0 && further[0].capture) {
         const furtherChains = getAllChainsForPiece(result.board, player, move.to);
         for (const fc of furtherChains) {
            chains.push({ moves: [move, ...fc.moves], board: fc.board });
         }
         continue;
      }
    }
    chains.push({ moves: [move], board: result.board });
  }
  return chains;
}

function getAllChainsForPiece(board: Board, player: Player, from: [number, number]): Chain[] {
  const moves = getValidMoves(board, player, from);
  if (moves.length === 0 || !moves[0].capture) return [{ moves: [], board }];
  
  const chains: Chain[] = [];
  for (const move of moves) {
    const result = applyMove(board, move);
    if (!result.promoted) {
      const further = getValidMoves(result.board, player, move.to);
      if (further.length > 0 && further[0].capture) {
        const subChains = getAllChainsForPiece(result.board, player, move.to);
        for (const sc of subChains) {
          chains.push({ moves: [move, ...sc.moves], board: sc.board });
        }
        continue;
      }
    }
    chains.push({ moves: [move], board: result.board });
  }
  return chains;
}

function minimax(board: Board, depth: number, alpha: number, beta: number, maximizing: boolean, botPlayer: Player): number {
  if (depth === 0) return evaluate(board, botPlayer);

  const player = maximizing ? botPlayer : (botPlayer === 1 ? 2 : 1);
  const chains = getAllChains(board, player);

  if (chains.length === 0) {
    return maximizing ? -Infinity : Infinity;
  }

  if (maximizing) {
    let maxEval = -Infinity;
    for (const chain of chains) {
      const ev = minimax(chain.board, depth - 1, alpha, beta, false, botPlayer);
      maxEval = Math.max(maxEval, ev);
      alpha = Math.max(alpha, ev);
      if (beta <= alpha) break;
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for (const chain of chains) {
      const ev = minimax(chain.board, depth - 1, alpha, beta, true, botPlayer);
      minEval = Math.min(minEval, ev);
      beta = Math.min(beta, ev);
      if (beta <= alpha) break;
    }
    return minEval;
  }
}

export function getBotMove(board: Board, player: Player, depth: number = 3): Chain | null {
  const chains = getAllChains(board, player);
  if (chains.length === 0) return null;

  let bestChain = null;
  let bestValue = -Infinity;

  for (const chain of chains) {
    const value = minimax(chain.board, depth - 1, -Infinity, Infinity, false, player);
    if (value > bestValue) {
      bestValue = value;
      bestChain = chain;
    }
  }

  return bestChain;
}
