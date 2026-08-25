/**
 * LOBBY DUEL RESULTS — the verdict overlay for the score-duel games
 * (Golf / Clumsy / Pug Shooter). Renders `lobbyGame:end`: winner headline,
 * the full scoreboard with your row highlighted, Exit / keep-watching.
 * Social verdict only — no RP, no money (scores are client-claimed).
 */
import { Trophy } from 'lucide-react';
import type { LobbyDuelEnd } from './onlineLobbyMatch';

export function LobbyDuelResults({
  end,
  onExit,
  onDismiss,
}: {
  end: LobbyDuelEnd;
  /** Leave to the lobby (the wrapper's normal leaveRound path). */
  onExit: () => void;
  /** Close the overlay but stay on the finished round. */
  onDismiss: () => void;
}) {
  const iWon = end.scores.some((s) => s.you && end.winners.includes(s.name));
  // Everyone tied at the top = a DRAW, not a room full of "winners".
  const isDraw = end.winners.length > 1;
  return (
    <div className="absolute inset-0 z-[110] flex items-center justify-center bg-[#030a12]/85 backdrop-blur-md p-6">
      <div className="w-full max-w-md rounded-3xl border border-[#00FFD1]/30 bg-[#041010]/95 p-8 text-center shadow-[0_0_60px_rgba(0,255,209,0.15)]">
        <Trophy className={`mx-auto h-10 w-10 ${iWon && !isDraw ? 'text-[#00FFD1]' : 'text-white/30'}`} />
        <h1 className="mt-3 text-3xl font-black italic uppercase tracking-tighter text-white">
          {isDraw ? 'Draw' : iWon ? 'You win' : `${end.winners.join(' · ')} wins`}
        </h1>
        <p className="mt-1 text-[10px] font-mono uppercase tracking-[0.3em] text-[#B1C5FF]/50">
          Score duel · highest score takes it
        </p>

        <div className="mt-6 space-y-2">
          {end.scores.map((row) => (
            <div
              key={row.name}
              className={`flex items-center justify-between rounded-xl border px-4 py-2.5 ${
                row.you
                  ? 'border-[#00FFD1]/50 bg-[#00FFD1]/10'
                  : 'border-white/10 bg-white/5'
              }`}
            >
              <span className="truncate text-sm font-bold uppercase tracking-wider text-white">
                {row.you ? `${row.name} (you)` : row.name}
              </span>
              <span className="font-mono text-sm font-black tabular-nums text-[#00FFD1]">
                {row.score.toLocaleString()}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-7 flex gap-3">
          <button
            onClick={onExit}
            className="flex-1 cursor-pointer rounded-full bg-[#00FFD1] py-3 text-[12px] font-black italic uppercase tracking-widest text-[#04211c] shadow-[0_0_30px_rgba(0,255,209,0.35)] transition-all hover:brightness-110"
          >
            Back to lobby
          </button>
          <button
            onClick={onDismiss}
            className="flex-1 cursor-pointer rounded-full border border-white/15 bg-white/5 py-3 text-[12px] font-black italic uppercase tracking-widest text-white/80 transition-all hover:bg-white/10"
          >
            Stay
          </button>
        </div>
      </div>
    </div>
  );
}

export default LobbyDuelResults;
