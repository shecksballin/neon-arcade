import { Chess } from 'chess.js';

// Base state: White's turn. Black hasn't moved yet.
const baseFen = 'r3k2r/p1pq1p1p/8/8/8/8/P1PQ1P1P/R3K2R w KQkq - 0 1';
const proj = new Chess(baseFen);

// Black premoves a7-a6
const targetPlayerChar = 'b';
// 1. Flip to 'b'
let tokens = proj.fen().split(' ');
tokens[1] = 'b';
tokens[3] = '-';
proj.load(tokens.join(' '));

// 2. Black moves
proj.move({ from: 'a7', to: 'a6' });

console.log("After Black's first premove, turn is:", proj.turn());

// 3. Ensure turn is 'b' for next premove
if (proj.turn() !== targetPlayerChar) {
  tokens = proj.fen().split(' ');
  tokens[1] = targetPlayerChar;
  tokens[3] = '-';
  proj.load(tokens.join(' '));
}

console.log("After flipping FEN back to 'b', FEN is:", proj.fen());

// Let's see if Black can castle now
console.log('Black king moves:', proj.moves({ square: 'e8', verbose: true }).map(m => m.san));
