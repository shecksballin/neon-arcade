import { Chess } from 'chess.js';
let fen = '4k3/8/8/8/8/8/8/4K2R w K - 0 1';
const chess = new Chess(fen);
chess.put({ type: 'q', color: 'b' }, 'e2');
console.log('board:', chess.ascii());
let tf = chess.fen().split(' ');
tf[1] = 'w';
chess.load(tf.join(' ')); // White's turn, King in check, but Queen can also capture it maybe? No, black queen can't capture white king when it's white's turn. 
const moves = chess.moves({ verbose: true });
console.log('moves:', moves.map(m => m.san));
