import { Chess } from 'chess.js';

// White just moved Bc4, attacking Black's pawn on f7, but black king on e8 is NOT in check
let fen = 'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR b KQkq - 1 2';

// Black wants to premove... wait, if White just moved, it's Black's turn. Premove happens when it's NOT your turn.
// Let's say it's Black's turn, Black plays Nc6. 
const chess = new Chess(fen);
chess.move('Nc6');
// Now it's White's turn. Black wants to premove.
console.log('After Black moves Nc6:', chess.fen());
// FEN is: r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3
// Let's say it's White's turn, Black is premoving.
// We getProjectedChess for Black.
const proj = new Chess(chess.fen());
let tokens = proj.fen().split(' ');
tokens[1] = 'b';
tokens[3] = '-';
try {
   proj.load(tokens.join(' '));
   console.log('Successfully flipped turn for black to prep premove');
} catch (e) {
   console.log('Error 1:', e.message);
}

// Now wait. What if White's move puts Black in CHECK?
const chess2 = new Chess('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
// White plays Bb5+ (not quite check, let me just setup a real check).
const chess3 = new Chess('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
// just directly construct FEN where white gives check to black, AND it's white's turn? No, that's impossible.
// If White gives check, it BECOMES Black's turn. So Black can't be premoving!
// Premoving only happens when it's WHITE'S turn.
// If it's White's turn, it means Black just moved. White's King might be in check? No, Black cannot leave their king in check or put White in check and then immediately White's king is in check AND it's White's turn.
// Wait, if Black just moved and PUT White in check, it is White's turn. White's king is in check.
// Black wants to queue a 2nd premove.
// We make `proj` for Black.
// `targetPlayerChar` = 'b'.
// FEN: `... w ...` where WHITE king is in check.
// We change turn to 'b'. So it's Black's turn, and WHITE'S KING is in check!
// Let's test this!!!
let fen4 = 'r1bqk1nr/pppp1ppp/2n5/4p3/1bB1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'; // White king in check
const proj2 = new Chess(fen4);
let tf = proj2.fen().split(' ');
tf[1] = 'b';
tf[3] = '-';
try {
    proj2.load(tf.join(' '));
    console.log('Loaded check fen successfully');
} catch (e) {
    console.log('Error 2:', e.message);
}

