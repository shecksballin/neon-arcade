import { Trophy } from 'lucide-react';
import { rankBoard, type BoardEntry } from '../leaderboard';

/** the AsteroidsCore top-right leaderboard, refitted for shootout history */
export function LeaderboardCard({ board, rows = 6 }: { board: BoardEntry[]; rows?: number }) {
  const ranked = rankBoard(board).slice(0, rows);
  return (
    <div className="backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 p-5 rounded-2xl w-64">
      <div className="flex items-center gap-3 mb-3">
        <Trophy className="w-4 h-4 text-yellow-500" />
        <h3 className="text-xs font-black text-white italic uppercase tracking-widest">Leaderboard</h3>
      </div>
      {ranked.length === 0 && (
        <p className="text-white/30 font-mono text-[10px] uppercase tracking-widest py-3 text-center">
          No shootouts yet
        </p>
      )}
      <div className="space-y-1.5">
        {ranked.map((e, i) => (
          <div
            key={e.date + '-' + i}
            className={`flex items-center justify-between p-2 rounded-lg text-[10px] font-mono border ${
              e.won
                ? 'bg-[#00FFD1]/10 text-[#00FFD1] border-[#00FFD1]/20'
                : 'text-white/40 border-white/5'
            }`}
          >
            <span className="opacity-50">#{i + 1}</span>
            <span className={`px-2 font-black italic ${e.won ? 'text-[#00FFD1]' : 'text-[#FF0080]'}`}>
              {e.won ? 'W' : 'L'}
            </span>
            <span className="flex-1 text-center font-bold text-white/80">{e.score}</span>
            <span className="opacity-60 text-right">P{e.perfect}·S{e.saves}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
