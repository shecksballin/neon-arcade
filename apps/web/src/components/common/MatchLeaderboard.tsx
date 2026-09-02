/**
 * MATCH LEADERBOARD — the Pug Shooter HUD board, for every game
 * =============================================================
 * Neon Pug Shooter's always-on top-right "Leaderboard" card is the arcade's
 * reference in-match board: a small glass card (black 40%, teal 20% border,
 * blur 10px), a trophy header, and mono rows of `#rank · NAME · value` with
 * the local player's row lit teal. This is that exact card as a React
 * component so Asteroids, Cells, Volley, Quiz and (in-iframe) Clumsy render
 * the same board instead of five hand-rolled variants.
 *
 * Faithful to the reference (public/neon-pug-shooter/index.html):
 *   card  — .hud-card: rgba(0,0,0,.4), 1px rgba(0,255,209,.2), radius 16,
 *           blur(10px); padding 20/22; width 256, top/right 32
 *   head  — yellow trophy glyph + 11px 900 italic uppercase .18em title
 *   row   — .lb-row: mono 10px, 7/9 padding, radius 9, white 5% border,
 *           35% white text; .me = teal text on 10% teal fill
 *
 * Data is caller-shaped: `value` is whatever the game counts (kills, mass,
 * points, tiles) with `valueLabel` naming it in the header. Rows are
 * rendered in the order given — sort before passing.
 */
import { Trophy } from 'lucide-react'

export interface MatchLeaderboardRow {
  name: string
  value: number | string
  isPlayer?: boolean
  /** Optional dot color (team/cell color); omitted = no dot, like pug FFA. */
  color?: string
}

export function MatchLeaderboard({
  rows,
  title = 'Leaderboard',
  valueLabel,
  max = 6,
  className = 'absolute top-8 right-8 w-64 z-[60] pointer-events-none',
}: {
  rows: MatchLeaderboardRow[]
  title?: string
  /** Small right-aligned unit tag in the header (K, PTS, MASS, TILES). */
  valueLabel?: string
  max?: number
  /** Position/size wrapper — override for games with a different corner. */
  className?: string
}) {
  if (rows.length === 0) return null
  return (
    <div className={className}>
      <div
        className="rounded-2xl px-[22px] py-5"
        style={{
          // Matches the in-iframe boards (pug .hud-card / Clumsy
          // #leaderboardCard): solid dark navy, NO backdrop blur — an
          // always-on blur over a live canvas re-blurs every frame, the
          // exact cost the perf pass removed from the iframe games.
          background: 'rgba(5,13,28,0.78)',
          border: '1px solid rgba(0,255,209,0.2)',
        }}
      >
        <div className="mb-3.5 flex items-center gap-[11px]">
          <Trophy size={16} className="shrink-0" style={{ color: '#eab308' }} />
          <h3 className="m-0 flex-1 text-[11px] font-black italic uppercase tracking-[0.18em] text-white">
            {title}
          </h3>
          {valueLabel && (
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/35">
              {valueLabel}
            </span>
          )}
        </div>
        {rows.slice(0, max).map((row, i) => (
          <div
            key={`${row.name}-${i}`}
            className="mt-1.5 flex items-center justify-between rounded-[9px] px-[9px] py-[7px] font-mono text-[10px]"
            style={
              row.isPlayer
                ? {
                    background: 'rgba(0,255,209,0.1)',
                    border: '1px solid rgba(0,255,209,0.2)',
                    color: '#00FFD1',
                  }
                : {
                    border: '1px solid rgba(255,255,255,0.05)',
                    color: 'rgba(255,255,255,0.35)',
                  }
            }
          >
            <span className="opacity-50">#{i + 1}</span>
            {row.color && (
              <span
                className="ml-2 h-2 w-2 shrink-0 rounded-full"
                style={{ background: row.color, boxShadow: `0 0 6px ${row.color}` }}
              />
            )}
            <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap px-[11px] italic uppercase">
              {row.name}
            </span>
            <span className="font-bold">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
