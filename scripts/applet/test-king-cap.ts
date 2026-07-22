import { Chess } from 'chess.js';
let fen = 'r1bqk1nr/pppp1ppp/2n5/4p3/1bB1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'; // White king in check
const proj = new Chess(fen);
let tf = proj.fen().split(' ');
tf[1] = 'b';
tf[3] = '-';
proj.load(tf.join(' ')); // Black's turn, white king is on e1
const moves = proj.moves({ square: 'b4', verbose: true });
console.log('Moves for b4 bishop:', moves.map(m => m.to));
