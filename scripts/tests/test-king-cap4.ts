import { Chess } from 'chess.js';
let fen = '4k3/8/8/8/8/8/8/4K2R w K - 0 1';
const chess = new Chess(fen);
chess.put({ type: 'q', color: 'b' }, 'e2');
let tf = chess.fen().split(' ');
tf[1] = 'b';
chess.load(tf.join(' ')); // Black's turn
const moves = chess.moves({ verbose: true });
console.log('moves:', moves.filter(m => m.to === 'e1' || m.to === 'h1'));
