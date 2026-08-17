/**
 * LEADERBOARD PANEL — top 100 by K/D, win rate or level (sidebar panel)
 * =====================================================================
 * Reads `GET /api/stats/leaderboard` with the two filters the design
 * contract asks for, plus the progression board:
 *
 *   METRIC   K/D  |  WIN RATE  |  LEVEL
 *   GAME     every game individually, or ALL GAMES (K/D + win rate only —
 *            LEVEL is one career total across the whole arcade)
 *
 * Reading the board:
 *   - WIN RATE excludes every row with no win condition — free play AND
 *     Slayer, whose contract is "no winner, points for kills" — so the
 *     `matches` column is the RANKED sample. K/D deliberately includes both.
 *   - With metric=K/D and game=ALL the server aggregates only the three games
 *     that track kills (Pug Shooter / Asteroids / Cells), so a chess player
 *     cannot pad their way past the sample floor.
 *   - A player needs at least `minMatches` (server-owned, currently 5) rows to
 *     appear at all. The contract asks for that floor to be VISIBLE, so it is
 *     printed under the table rather than silently applied.
 *
 * RANKED 2.0: each row's chip shows the player's tier AND division when the
 * payload carries `rp` (the visible ladder number), e.g. "SILVER III". `rp`
 * is optional — a division cannot be invented client-side, so a row without
 * it degrades to the bare tier the server already sends. See `RankChip` in
 * UserRow.tsx and the `rankRpOf` note in lib/api.ts.
 *
 * ‼️ SECURITY: a leaderboard row is `{ rank, username, value, matches, tier,
 * rp? }`. `username` is the only identifier the server sends and the only one
 * this file renders — there is no wallet anywhere in the payload, so there is
 * nothing here that could leak one. Usernames render as plain text (React
 * escapes); never dangerouslySetInnerHTML.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, RefreshCw, Trophy } from 'lucide-react'
import { formatXp } from '@neon/types'
import { statsApi } from '../../lib/api'
import type {
  LeaderboardResponse,
  LeaderboardRow,
  XpLeaderboardResponse,
  XpLeaderboardRow,
} from '../../lib/api'
import { RankChip, UserAvatar } from './UserRow'
import type { SocialPanelProps } from './socialContract'
import {
  GAME_KEYS,
  KD_GAMES,
  formatCount,
  formatKd,
  formatPercent,
  gameLabel,
  readableError,
} from './StatsPanel'

type Metric = 'kd' | 'winrate' | 'xp'

/**
 * The game filter. K/D only means anything for the three shooters, so when
 * the metric is K/D the picker offers exactly those (plus ALL) — offering
 * "chess K/D" would just render an empty board.
 *
 * LEVEL has no per-game split at all: XP is one career total across the whole
 * arcade (that is the point of it), so the picker is hidden entirely.
 */
function gameOptions(metric: Metric): string[] {
  if (metric === 'xp') return ['all']
  return metric === 'kd' ? ['all', ...KD_GAMES] : ['all', ...GAME_KEYS]
}

export default function LeaderboardPanel({ onClose }: SocialPanelProps) {
  const [metric, setMetric] = useState<Metric>('winrate')
  const [gameKey, setGameKey] = useState<string>('all')

  const options = gameOptions(metric)

  /** Switching metric can invalidate the current game filter — snap to ALL. */
  const changeMetric = (next: Metric) => {
    setMetric(next)
    if (!gameOptions(next).includes(gameKey)) setGameKey('all')
  }

  const query = useQuery({
    queryKey: ['stats', 'leaderboard', metric, gameKey],
    // The XP board is the same endpoint with a different row shape, so it
    // gets its own call and is narrowed by `metric` below rather than being
    // forced into the K/D + win-rate row type.
    queryFn: async (): Promise<LeaderboardResponse | XpLeaderboardResponse> =>
      metric === 'xp'
        ? statsApi.xpLeaderboard(100)
        : statsApi.leaderboard(metric, gameKey, 100),
    staleTime: 60_000,
  })

  const data = query.data
  const isXp = data?.metric === 'xp'
  const rows = data?.rows ?? []

  let body: ReactNode
  if (query.isPending) {
    body = <LoadingRows />
  } else if (query.isError) {
    body = (
      <ErrorBlock
        message={readableError(query.error, 'Could not load the leaderboard')}
        onRetry={() => void query.refetch()}
      />
    )
  } else if (rows.length === 0) {
    body = (
      <EmptyBlock
        minMatches={data?.minMatches ?? 5}
        metric={metric}
        gameKey={gameKey}
      />
    )
  } else if (isXp) {
    body = (
      <div className="space-y-1">
        {(rows as XpLeaderboardRow[]).map((row) => (
          <XpLeaderRow key={`${row.rank}-${row.username}`} row={row} />
        ))}
      </div>
    )
  } else {
    body = (
      <div className="space-y-1">
        {(rows as LeaderboardRow[]).map((row) => (
          <LeaderRow key={`${row.rank}-${row.username}`} row={row} metric={metric} />
        ))}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col font-mono text-white">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[#00ffd1]/20 bg-gradient-to-r from-[#00ffd1]/10 to-transparent p-4">
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Back"
            className="cursor-pointer text-white/50 transition-colors hover:text-[#00ffd1]"
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <Trophy size={18} className="shrink-0 text-[#00ffd1]" />
        <h3 className="flex-1 text-sm font-black uppercase tracking-[0.2em] text-[#00ffd1]">
          Leaderboard
        </h3>
        <button
          onClick={() => void query.refetch()}
          aria-label="Refresh leaderboard"
          disabled={query.isFetching}
          className="cursor-pointer text-white/40 transition-colors hover:text-[#00ffd1] disabled:opacity-40"
        >
          <RefreshCw size={14} className={query.isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* METRIC toggle */}
      <div className="flex gap-2 px-4 pt-4">
        <TogglePill
          label="Win rate"
          active={metric === 'winrate'}
          onClick={() => changeMetric('winrate')}
        />
        <TogglePill
          label="K / D"
          active={metric === 'kd'}
          onClick={() => changeMetric('kd')}
        />
        <TogglePill
          label="Level"
          active={metric === 'xp'}
          onClick={() => changeMetric('xp')}
        />
      </div>

      {/* GAME filter — horizontally scrollable so it never wraps the drawer.
          Hidden on the LEVEL board, which is arcade-wide by definition. */}
      {metric !== 'xp' && (
        <div className="flex gap-1.5 overflow-x-auto px-4 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {options.map((key) => (
            <FilterChip
              key={key}
              label={key === 'all' ? 'All games' : gameLabel(key)}
              active={gameKey === key}
              onClick={() => setGameKey(key)}
            />
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{body}</div>

      {/* The sample floor, surfaced as the contract requires. */}
      <div className="border-t border-[#00ffd1]/10 px-4 py-3 text-[9px] uppercase leading-relaxed tracking-wider text-white/30">
        {metric === 'xp' ? (
          <>
            Career XP across every game — no minimum. Levels get more
            expensive as they go, so the top of this board is time played, not
            luck.
          </>
        ) : (
          <>
            Minimum {data?.minMatches ?? 5} matches to qualify.{' '}
            {metric === 'winrate'
              ? 'Free play and Slayer are excluded — they have no winner.'
              : 'Free play and Slayer count toward K/D.'}
          </>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────
// ROW
// ─────────────────────────────────────────────────

function LeaderRow({ row, metric }: { row: LeaderboardRow; metric: Metric }) {
  const value = metric === 'kd' ? formatKd(row.value) : formatPercent(row.value)

  return (
    <div className="flex items-center gap-3 rounded-lg border border-transparent px-2 py-2 transition-colors hover:bg-white/5">
      {/* Position. Top three get the neon treatment. */}
      <span
        className={`w-7 shrink-0 text-right text-xs font-black tabular-nums ${
          row.rank <= 3 ? 'text-[#00ffd1]' : 'text-white/35'
        }`}
      >
        {row.rank}
      </span>

      {/* `online` is deliberately not passed: the leaderboard carries no
          presence, and a permanently grey dot would read as "everyone is
          offline". */}
      <UserAvatar username={row.username} size={28} />

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm tracking-wide text-white/90">
          {row.username}
        </div>
        {/* `rp` gives the division ("SILVER III"); without it the chip falls
            back to the tier alone. The row already prints a metric on the
            right, so the RP number itself is left off to keep it readable. */}
        <RankChip rank={row.tier} rp={row.rp} showRp={false} />
      </div>

      <div className="shrink-0 text-right">
        <div className="text-sm font-black tabular-nums text-[#00ffd1]">
          {value}
        </div>
        <div className="text-[9px] uppercase tracking-wider text-white/30">
          {formatCount(row.matches)}
        </div>
      </div>
    </div>
  )
}

/**
 * One row of the LEVEL board.
 *
 * It shows the level in its band colour rather than a rank chip: XP and RP
 * are different ladders, and putting a rank badge on a progression board
 * would invite reading one as the other. The XP total goes underneath as the
 * tiebreaker it actually is — two players can share a level and still be
 * thousands of XP apart.
 */
function XpLeaderRow({ row }: { row: XpLeaderboardRow }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-transparent px-2 py-2 transition-colors hover:bg-white/5">
      <span
        className={`w-7 shrink-0 text-right text-xs font-black tabular-nums ${
          row.rank <= 3 ? 'text-[#00ffd1]' : 'text-white/35'
        }`}
      >
        {row.rank}
      </span>

      <UserAvatar username={row.username} size={28} />

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm tracking-wide text-white/90">
          {row.username}
        </div>
        <span
          className="text-[9px] uppercase tracking-[0.15em]"
          style={{ color: row.color }}
        >
          {row.band}
        </span>
      </div>

      <div className="shrink-0 text-right">
        <div
          className="text-sm font-black tabular-nums"
          style={{ color: row.color }}
        >
          {row.level}
        </div>
        <div className="text-[9px] uppercase tracking-wider text-white/30">
          {formatXp(row.xp)} XP
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────
// CONTROLS + STATES
// ─────────────────────────────────────────────────

function TogglePill({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex-1 cursor-pointer rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition-all ${
        active
          ? 'border-[#00ffd1] bg-[#00ffd1]/15 text-[#00ffd1] shadow-[0_0_12px_rgba(0,255,209,0.35)]'
          : 'border-[#00ffd1]/25 text-white/50 hover:text-white/80'
      }`}
    >
      {label}
    </button>
  )
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-3 py-1 text-[9px] uppercase tracking-[0.14em] transition-all ${
        active
          ? 'border-[#00ffd1]/70 bg-[#00ffd1]/10 text-[#00ffd1]'
          : 'border-white/10 text-white/40 hover:text-white/70'
      }`}
    >
      {label}
    </button>
  )
}

function LoadingRows() {
  return (
    <div className="space-y-1" aria-busy="true" aria-label="Loading leaderboard">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="h-12 animate-pulse rounded-lg border border-[#00ffd1]/10 bg-[#00ffd1]/5"
        />
      ))}
    </div>
  )
}

function ErrorBlock({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-center">
      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-red-400">
        Leaderboard unavailable
      </div>
      <p className="mt-2 text-xs leading-relaxed text-white/60">{message}</p>
      <button
        onClick={onRetry}
        className="mt-3 cursor-pointer rounded-full border border-[#00ffd1]/40 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#00ffd1] transition-colors hover:bg-[#00ffd1]/10"
      >
        Retry
      </button>
    </div>
  )
}

function EmptyBlock({
  minMatches,
  metric,
  gameKey,
}: {
  minMatches: number
  metric: Metric
  gameKey: string
}) {
  return (
    <div className="rounded-xl border border-[#00ffd1]/20 bg-black/40 p-5 text-center">
      <div className="text-xs font-black uppercase tracking-[0.18em] text-[#00ffd1]">
        {metric === 'xp' ? 'Nobody has any XP yet' : 'Nobody qualifies yet'}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-white/50">
        {metric === 'xp' ? (
          <>
            XP is awarded for every finished game, win or lose. Play anything
            in the arcade and this fills up.
          </>
        ) : (
          <>
            {metric === 'kd' ? 'K/D' : 'Win rate'} for{' '}
            {gameKey === 'all' ? 'all games' : gameLabel(gameKey)} needs at
            least {minMatches} recorded{' '}
            {minMatches === 1 ? 'match' : 'matches'} per player. Play some
            online matches and this fills up.
          </>
        )}
      </p>
    </div>
  )
}
