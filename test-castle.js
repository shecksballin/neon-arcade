const { Chess } = require('chess.js');
const fen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1'; // White to move
const chess = new Chess(fen);
const tokens = chess.fen().split(' ');
tokens[1] = 'b';
tokens[3] = '-';
console.log('Flipped FEN:', tokens.join(' '));
const flipped = new Chess();
let success = true;
try {
  flipped.load(tokens.join(' '));
} catch (e) {
  console.log("Error loading FEN:", e.message);
  success = false;
}
if (success) {
  console.log('Black king moves:', flipped.moves({ square: 'e8', verbose: true }).map(m => m.san));
}
