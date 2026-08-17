import { Chess } from 'chess.js';
let fen = 'rnbqk1nr/pppp1ppp/2P5/4p3/1bB1P3/8/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const proj = new Chess(fen);
let tf = proj.fen().split(' ');
tf[1] = 'b';
tf[3] = '-';
proj.load(tf.join(' ')); // Black's turn
const moves = proj.moves({ verbose: true });
console.log('Is e1 in any moves?', moves.some(m => m.to === 'e1'));
console.log('Moves attacking e1:', moves.filter(m => m.to === 'e1').map(m => m.san));
