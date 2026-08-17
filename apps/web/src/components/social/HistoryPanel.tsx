/**
 * HISTORY PANEL — your recent matches (sidebar panel)
 * ===================================================
 * Reads `GET /api/stats/history`, newest first, keyset-paginated: the server
 * hands back an opaque `nextCursor` which we pass straight back to load more.
 *
 * Reading a row:
 *   - `result` is 'win' | 'loss' | 'draw' | 'none'. **'none' is FREE PLAY**,
 *     which has no win condition — it renders as a dash, NEVER as a loss.
 *   - kills/deaths are shown for the three games that track them (Pug Shooter,
 *     Asteroids, Cells); every other game shows its score instead.
 *   - `opponentUsername` is a USERNAME or null (free play, bots, players who
 *     never finished account setup).
 *
 * RANKED 2.0 (optional fields — a row only has them if it actually settled
 * on a ladder):
 *   - `rpChange` is the RP won/lost, `rpAfter` the RP you left the match on;
 *     together they render "+24 RP → SILVER III". Practice, local, computer
 *     and free-play rows have neither, so they show nothing extra — those
 *     paths are unranked by contract and this panel must never imply
 *     otherwise.
 *   - `shielded` marks a loss the demotion shield clamped at your tier floor.
 *
 * ‼️ SECURITY: the payload contains no wallet — the opponent is identified by
 * username only, exactly like every other social surface. Usernames and
 * bodies render as plain text; never dangerouslySetInnerHTML.
 */

import type { ReactNode } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { ChevronLeft, History as HistoryIcon, RefreshCw, Shield } from 'lucide-react'
import { rpChangeLabel } from '@neon/types'
import { statsApi } from '../../lib/api'
import type { HistoryPage, HistoryRow } from '../../lib/api'
import { RankChip } from './UserRow'
import type { SocialPanelProps } from './socialContract'
import {
  KD_GAMES,
  formatCount,
  gameLabel,
  modeLabel,
  readableError,
} from './StatsPanel'

const PAGE_SIZE = 25

export default function HistoryPanel({ onClose }: SocialPanelProps) {
  const query = useInfiniteQuery({
    queryKey: ['stats', 'history'],
    // `pageParam` is the server's opaque cursor (null on the first page).
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<HistoryPage> =>
      statsApi.history(PAGE_SIZE, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  })

  const matches = query.data?.pages.flatMap((page) => page.matches) ?? []

  let body: ReactNode
  if (query.isPending) {
    body = <LoadingRows />
  } else if (query.isError) {
    body = (
      <ErrorBlock
        message={readableError(query.error, 'Could not load your history')}
        onRetry={() => void query.refetch()}
      />
    )
  } else if (matches.length === 0) {
    body = <EmptyBlock />
  } else {
    body = (
      <div className="space-y-1.5">
        {matches.map((match, i) => (
          // There is no id in the row payload, so the key is the natural
          // one: nothing else finished at the same instant for this player.
          <MatchRow key={`${match.createdAt}-${i}`} match={match} />
        ))}

        {query.hasNextPage && (
          <button
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="mt-2 w-full cursor-pointer rounded-full border border-[#00ffd1]/30 py-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#00ffd1]/80 transition-colors hover:bg-[#00ffd1]/10 disabled:opacity-40"
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
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
        <HistoryIcon size={18} className="shrink-0 text-[#00ffd1]" />
        <h3 className="flex-1 text-sm font-black uppercase tracking-[0.2em] text-[#00ffd1]">
          Match history
        </h3>
        <button
          onClick={() => void query.refetch()}
          aria-label="Refresh history"
          disabled={query.isFetching}
          className="cursor-pointer text-white/40 transition-colors hover:text-[#00ffd1] disabled:opacity-40"
        >
          <RefreshCw size={14} className={query.isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>

      <div className="border-t border-[#00ffd1]/10 px-4 py-3 text-[9px] uppercase leading-relaxed tracking-wider text-white/30">
        Online matches only — practice and computer games are not recorded.
        Free play and Slayer show a dash instead of a result — neither has a
        winner. RP is shown on ranked matches only.
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────
// ROW
// ─────────────────────────────────────────────────

/** Colour + label for a result. 'none' (free play / slayer) is neutral,
 *  never red — neither mode has a winner, so neither has a loser. */
function resultStyle(result: HistoryRow['result']): {
  label: string
  className: string
} {
  switch (result) {
    case 'win':
      return { label: 'WIN', className: 'text-green-400 border-green-400/40' }
    case 'loss':
      return { label: 'LOSS', className: 'text-red-400 border-red-400/40' }
    case 'draw':
      return { label: 'DRAW', className: 'text-yellow-300 border-yellow-300/40' }
    default:
      // FREE PLAY or SLAYER — no win condition, so a dash. Rendering this as
      // a loss would be a lie about the player's record.
      return { label: '—', className: 'text-white/40 border-white/15' }
  }
}

/** "2m 14s", or null when the server did not record a duration. */
function formatDuration(ms: number | null): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** Relative time — history is read as "when", not "on which date". */
function formatWhen(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(then).toLocaleDateString()
}

/** A finite number, or null — the guard every optional RP field goes through. */
function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function MatchRow({ match }: { match: HistoryRow }) {
  const result = resultStyle(match.result)
  const tracksKd = KD_GAMES.includes(match.gameKey)
  const duration = formatDuration(match.durationMs)

  // Ranked 2.0. Absent on every unranked row (free play, practice, local,
  // vs-computer) — and `0` is a real value, so this is a null check, not a
  // truthiness check.
  const rpChange = finite(match.rpChange)
  const rpAfter = finite(match.rpAfter)

  return (
    <div className="rounded-xl border border-[#00ffd1]/15 bg-black/40 p-3">
      <div className="flex items-center gap-2">
        {/* Result badge */}
        <span
          className={`shrink-0 rounded-md border px-2 py-1 text-[9px] font-black tracking-[0.14em] ${result.className}`}
        >
          {result.label}
        </span>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold tracking-wide text-white">
            {gameLabel(match.gameKey)}
          </div>
          <div className="truncate text-[9px] uppercase tracking-[0.14em] text-white/35">
            {modeLabel(match.mode)}
            {match.placement ? ` · #${match.placement}` : ''}
            {duration ? ` · ${duration}` : ''}
          </div>
        </div>

        <span className="shrink-0 text-[9px] uppercase tracking-wider text-white/30">
          {formatWhen(match.createdAt)}
        </span>
      </div>

      {/* RP line — only for rows that actually settled on a ladder. */}
      {(rpChange !== null || rpAfter !== null) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          {rpChange !== null && (
            <span
              className={`rounded-md border px-1.5 py-0.5 text-[9px] font-black tabular-nums tracking-[0.1em] ${
                rpChange > 0
                  ? 'border-[#00ffd1]/40 text-[#00ffd1]'
                  : rpChange < 0
                    ? 'border-red-400/40 text-red-400'
                    : 'border-white/15 text-white/40'
              }`}
            >
              {rpChangeLabel(rpChange)} RP
            </span>
          )}
          {/* The badge the match left you on — tier AND division. */}
          {rpAfter !== null && <RankChip rp={rpAfter} />}
          {match.shielded && (
            <span
              title="Demotion shield — this loss was clamped at your tier floor"
              className="flex items-center gap-1 text-[9px] uppercase tracking-[0.14em] text-yellow-300/70"
            >
              <Shield size={10} />
              Shielded
            </span>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-white/50">
        {/* Kills/deaths only where they mean something; score otherwise. */}
        {tracksKd ? (
          <span>
            <span className="text-white/30">K/D</span>{' '}
            <span className="text-white/80 tabular-nums">
              {formatCount(match.kills)} / {formatCount(match.deaths)}
            </span>
          </span>
        ) : (
          match.score > 0 && (
            <span>
              <span className="text-white/30">Score</span>{' '}
              <span className="text-white/80 tabular-nums">
                {formatCount(match.score)}
              </span>
            </span>
          )
        )}

        {/* Usernames only — the payload has no wallet to leak. */}
        {match.opponentUsername && (
          <span className="min-w-0 truncate">
            <span className="text-white/30">vs</span>{' '}
            <span className="text-white/80">{match.opponentUsername}</span>
          </span>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────
// STATES
// ─────────────────────────────────────────────────

function LoadingRows() {
  return (
    <div className="space-y-1.5" aria-busy="true" aria-label="Loading history">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-20 animate-pulse rounded-xl border border-[#00ffd1]/10 bg-[#00ffd1]/5"
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
        History unavailable
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

function EmptyBlock() {
  return (
    <div className="rounded-xl border border-[#00ffd1]/20 bg-black/40 p-5 text-center">
      <div className="text-xs font-black uppercase tracking-[0.18em] text-[#00ffd1]">
        No matches yet
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-white/50">
        Finish an online match — wager, private wager or free play — and it
        shows up here with your result and stats.
      </p>
    </div>
  )
}
