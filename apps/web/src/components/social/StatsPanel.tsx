/**
 * STATS PANEL — per-game and combined career stats (sidebar panel)
 * =================================================================
 * Reads `GET /api/stats/me` ONCE and renders BOTH halves of the owner's
 * toggle from that single response:
 *
 *   PER GAME   one card per game the player has actually played
 *   COMBINED   the totals across every one of those games
 *
 * THE STATS RULES (design contract) as they land on screen:
 *   - K/D is shown for Pug Shooter, Asteroids and Cells in ALL modes, free
 *     play included. The server flags those rows with `tracksKd`, so the UI
 *     never has to guess from a game name.
 *   - Win rate covers LAST MAN STANDING and the other games' win conditions.
 *     It does NOT cover free play or SLAYER: slayer has no winner by contract
 *     (everybody scores their kills), so its rows are written with
 *     `result: 'none'` exactly like free play and feed K/D only. The server
 *     computes win rate over `rankedMatches` (every no-result row excluded)
 *     and sends `null` when there are none — we render an em dash, never
 *     "0%", never NaN. A brand-new account therefore reads as "no matches
 *     yet", not as a 0% player.
 *
 * SECURITY: `/api/stats/me` only ever describes the signed-in account
 * (identity comes from the JWT server-side, never from a query param) and
 * returns no wallets — nothing here can leak another user's identifier.
 *
 * This file also owns the small shared vocabulary + formatters used by
 * LeaderboardPanel and HistoryPanel (game/mode labels, number formatting), so
 * the three stats surfaces can never drift apart in how they read.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, RefreshCw, TrendingUp } from 'lucide-react'
import { formatXp, getLevelInfo, getRankInfo, xpGainLabel } from '@neon/types'
import { ApiError, profileApi, rankRpOf, statsApi } from '../../lib/api'
import { RankMeter } from './UserRow'
import { SOCIAL_KEYS } from './socialContract'
import { hasAuthToken } from './usePresence'
import { onXpAward } from '../../lib/sessionXp'

// ─────────────────────────────────────────────────
// SHARED VOCABULARY (also imported by Leaderboard/History)
// ─────────────────────────────────────────────────

/** Every gameKey the backend records stats for (server: statsService.GAME_KEYS). */
export const GAME_KEYS = [
  'chess',
  'volley',
  'connect',
  'kickoff',
  'cells',
  'asteroids',
  'golf',
  'clumsy',
  'pugshooter',
] as const

/** Display names, matching the titles used on the arcade tiles in App.tsx. */
export const GAME_LABELS: Record<string, string> = {
  chess: 'Neon Chess',
  volley: 'Neon Volley',
  connect: 'Neon Connect',
  kickoff: 'Neon Kickoff',
  // Legacy label only — Neon Quiz was removed; old history rows keep a name.
  trivia: 'Neon Quiz',
  cells: 'Neon Cells',
  asteroids: 'Neon Asteroids',
  golf: 'Neon Golf Clash',
  clumsy: 'Neon Clumsy',
  pugshooter: 'Neon Pug Shooter',
}

/**
 * The games whose K/D is meaningful (contract: Pug Shooter, Asteroids,
 * Cells — every mode). Mirrors `statsService.KD_GAMES`; used where a payload
 * has no `tracksKd` flag of its own (history rows).
 */
export const KD_GAMES: readonly string[] = ['pugshooter', 'asteroids', 'cells']

/** The mode value that marks a free-play row — no win condition, K/D only. */
export const FREEPLAY_MODE = 'freeplay'

/** Pretty name for a gameKey, tolerant of a key we have never seen. */
export function gameLabel(gameKey: string): string {
  return GAME_LABELS[gameKey] ?? gameKey.replace(/[_-]+/g, ' ').toUpperCase()
}

/** The last-man-standing mode key (renamed from the old 'snake'). */
export const LMS_MODE = 'lms'

/** Pretty name for a mode ('quiz_ffa' → 'QUIZ FFA', 'freeplay' → 'FREE PLAY'). */
export function modeLabel(mode: string): string {
  if (mode === FREEPLAY_MODE) return 'FREE PLAY'
  if (mode === LMS_MODE) return 'LAST MAN STANDING'
  return mode.replace(/[_-]+/g, ' ').toUpperCase()
}

// ─────────────────────────────────────────────────
// FORMATTERS — the "never render NaN" rules live here
// ─────────────────────────────────────────────────

/** Win rate as a percent, or an em dash when there is nothing to average. */
export function formatPercent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)}%`
    : '—'
}

/** K/D to two decimals, or an em dash when the number is missing/garbage. */
export function formatKd(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(2)
    : '—'
}

/** Plain integer with thousands separators, em dash when missing. */
export function formatCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value).toLocaleString()
    : '—'
}

/** "1 match" / "12 matches" — small thing, read everywhere. */
export function matchesLabel(n: number): string {
  return `${formatCount(n)} ${n === 1 ? 'match' : 'matches'}`
}

/**
 * The rows that carry NO win/loss, split into the two ways that happens.
 *
 * `rankedMatches` counts only win/loss/draw rows, so `matches - rankedMatches`
 * is everything with `result: 'none'`. The server counts free play separately
 * (`freeplayMatches`), and the ONLY other no-result mode is SLAYER — no winner
 * by contract — so whatever is left over is slayer. Used so the panel never
 * calls a slayer match "free play".
 */
export function unrankedSplit(stats: {
  matches: number
  rankedMatches: number
  freeplayMatches: number
}): { total: number; freeplay: number; noWinner: number } {
  const total = Math.max(0, stats.matches - stats.rankedMatches)
  const freeplay = Math.min(total, Math.max(0, stats.freeplayMatches))
  return { total, freeplay, noWinner: total - freeplay }
}

/** "2 matches free play · 3 matches slayer", or null when everything ranks. */
export function unrankedLabel(stats: {
  matches: number
  rankedMatches: number
  freeplayMatches: number
}): string | null {
  const { total, freeplay, noWinner } = unrankedSplit(stats)
  if (total === 0) return null
  const parts: string[] = []
  if (freeplay > 0) parts.push(`${matchesLabel(freeplay)} free play`)
  if (noWinner > 0) parts.push(`${matchesLabel(noWinner)} slayer`)
  return parts.length ? parts.join(' · ') : matchesLabel(total)
}

/** Short caption for a win rate that has nothing to average yet. */
export function unrankedCaption(stats: {
  matches: number
  rankedMatches: number
  freeplayMatches: number
}): string {
  const { freeplay, noWinner } = unrankedSplit(stats)
  if (freeplay > 0 && noWinner > 0) return 'free play + slayer only'
  if (noWinner > 0) return 'slayer only'
  if (freeplay > 0) return 'free play only'
  return 'no ranked matches yet'
}

/** Turns any thrown value into something a player can read. */
export function readableError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

// ─────────────────────────────────────────────────
// RESPONSE SHAPES — pinned by the design contract
// (`apps/server/src/routes/stats.ts` + `services/statsService.ts`)
// ─────────────────────────────────────────────────

export interface GameStats {
  gameKey: string
  /** Every recorded row, free play included. */
  matches: number
  /** Rows that count toward win rate (every `result: 'none'` row excluded —
   *  i.e. free play AND slayer, which has no winner). */
  rankedMatches: number
  /** Free-play rows — kills/deaths only. */
  freeplayMatches: number
  wins: number
  losses: number
  draws: number
  /** Percent 0–100, or null when there are no ranked matches. */
  winRate: number | null
  kills: number
  deaths: number
  kd: number
  /** True when this game's K/D is meaningful (Pug Shooter/Asteroids/Cells). */
  tracksKd: boolean
}

export interface StatsMeResponse {
  gameKey: string
  perGame: GameStats[]
  combined: GameStats
  kdGames: string[]
}

// ─────────────────────────────────────────────────
// PANEL
// ─────────────────────────────────────────────────

type StatsView = 'perGame' | 'combined'

export default function StatsPanel({ onClose }: { onClose?: () => void }) {
  // The toggle the owner asked for. Per-game first: it is the view that
  // actually answers "how am I doing at this game?".
  const [view, setView] = useState<StatsView>('perGame')

  const query = useQuery({
    queryKey: ['stats', 'me', 'all'],
    // Always ask for 'all': the response carries per-game rows AND the
    // combined totals, so the toggle costs zero extra requests.
    // The return type is pinned by the contract — annotating it here keeps
    // every render below type-checked independently of the shared helper.
    queryFn: async (): Promise<StatsMeResponse> => statsApi.me('all'),
    staleTime: 30_000,
  })

  const data = query.data
  const perGame = data?.perGame ?? []
  const combined = data?.combined

  let body: ReactNode

  if (query.isPending) {
    body = <LoadingBlock />
  } else if (query.isError) {
    body = (
      <ErrorBlock
        message={readableError(query.error, 'Could not load your stats')}
        onRetry={() => void query.refetch()}
      />
    )
  } else if (!combined || combined.matches === 0) {
    // A brand-new account: say so plainly instead of rendering a wall of
    // zeroes (and never a 0% win rate, which reads as "you lose everything").
    body = <EmptyBlock />
  } else if (view === 'combined') {
    body = <CombinedView combined={combined} gameCount={perGame.length} />
  } else {
    body = (
      <div className="space-y-3">
        {perGame.map((g) => (
          <GameCard key={g.gameKey} stats={g} />
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
        <TrendingUp size={18} className="shrink-0 text-[#00ffd1]" />
        <h3 className="flex-1 text-sm font-black uppercase tracking-[0.2em] text-[#00ffd1]">
          Stats
        </h3>
        <button
          onClick={() => void query.refetch()}
          aria-label="Refresh stats"
          disabled={query.isFetching}
          className="cursor-pointer text-white/40 transition-colors hover:text-[#00ffd1] disabled:opacity-40"
        >
          <RefreshCw size={14} className={query.isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* PROGRESSION — level first: every game feeds it, so it is the one
          number on this screen that is never "—" for an active player. */}
      <LevelStrip />

      {/* RANK — both ladders, above the per-game numbers. */}
      <RankStrip />

      {/* PER GAME / COMBINED toggle */}
      <div className="flex gap-2 px-4 pt-4">
        <TogglePill
          label="Per game"
          active={view === 'perGame'}
          onClick={() => setView('perGame')}
        />
        <TogglePill
          label="Combined"
          active={view === 'combined'}
          onClick={() => setView('combined')}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>

      {/* The one rule that explains every "—" on this screen. */}
      <div className="border-t border-[#00ffd1]/10 px-4 py-3 text-[9px] uppercase leading-relaxed tracking-wider text-white/30">
        Online matches only — practice and computer games are not recorded.
        Free play and Slayer have no win condition, so they count toward K/D
        but never win rate.
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────
// LEVEL STRIP — XP progression, arcade-wide
// ─────────────────────────────────────────────────
/**
 * The counterpart to the rank strip below, and deliberately the opposite kind
 * of number:
 *
 *   RANK   how good you are. Ranked matches only, two ladders, can go DOWN,
 *          resets every season.
 *   LEVEL  how much you have played. EVERY game and mode pays into it — free
 *          play, slayer, practice rounds of the single-player games — it never
 *          falls, and a season rollover leaves it alone.
 *
 * Because of that it is drawn FIRST: a player who has never touched a ranked
 * queue still has a level, so this is the one progress bar that is never
 * empty for someone who has actually been playing.
 *
 * Levels get harder as they go (the curve lives in @neon/types/xp.ts), which
 * is why the bar shows "X / Y XP" for the CURRENT level rather than a career
 * total — the width of the level is the interesting part.
 *
 * Reads GET /api/stats/xp. Renders nothing when signed out or on failure —
 * same rule as the rank strip: no strip beats a fake one.
 */
function LevelStrip() {
  const signedIn = hasAuthToken()

  const query = useQuery({
    queryKey: ['stats', 'xp'],
    queryFn: statsApi.xp,
    enabled: signedIn,
    staleTime: 30_000,
  })

  // The single-player games (golf/clumsy/pug shooter) credit XP through a
  // plain fetch from outside React — see lib/sessionXp.ts — so there is no
  // query invalidation to ride on. They announce the award instead, and this
  // is what listens for it: finish a round, open the panel, see the new level.
  const refetch = query.refetch
  useEffect(() => onXpAward(() => void refetch()), [refetch])

  const data = query.data
  if (!signedIn || !data) return null

  // Derive from the XP total rather than trusting the server's copy of the
  // level — one curve, one answer (the same rule getRankInfo follows).
  const info = getLevelInfo(data.xp)
  const last = data.recent[0]

  return (
    <div className="mx-4 mt-4 space-y-2 rounded-xl border border-[#00ffd1]/20 bg-black/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] uppercase tracking-[0.2em] text-[#00ffd1]/60">
          Progression
        </span>
        <span className="text-[9px] uppercase tracking-[0.16em] text-white/30">
          {formatXp(info.xp)} XP total
        </span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className="text-lg font-black uppercase tracking-wider"
          style={{ color: info.color, textShadow: `0 0 14px ${info.color}55` }}
        >
          {info.label}
        </span>
        <span
          className="text-[10px] font-bold uppercase tracking-[0.18em]"
          style={{ color: `${info.color}99` }}
        >
          {info.band}
        </span>
      </div>

      {/* Progress across the CURRENT level. Max level pins at 100% and says
          so instead of showing a bar that can never move again. */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${info.progressPct}%`,
            background: `linear-gradient(90deg, ${info.color}, ${info.color}88)`,
            boxShadow: `0 0 10px ${info.color}66`,
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-wider text-white/35">
        {info.isMaxLevel ? (
          <span>Max level — every match still banks XP</span>
        ) : (
          <>
            <span className="tabular-nums">
              {formatXp(info.xpIntoLevel)} / {formatXp(info.xpForLevel)} XP
            </span>
            <span className="tabular-nums">
              {formatXp(info.xpToNextLevel)} to level {info.level + 1}
            </span>
          </>
        )}
      </div>

      {/* What the last match paid — the one line that makes the system legible
          ("I got XP for that, and this is how much"). */}
      {last && (
        <p className="text-[9px] uppercase tracking-wider text-white/30">
          Last: {xpGainLabel(last.amount)} · {gameLabel(last.gameKey)}
          {last.leveledUp && (
            <span className="ml-1 font-bold text-[#00ffd1]">· levelled up</span>
          )}
        </p>
      )}

      <p className="text-[9px] uppercase leading-relaxed tracking-wider text-white/30">
        Every game pays XP — wins, losses and free play. Each level costs more
        than the last.
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────
// RANK STRIP — the Ranked 2.0 badges, both ladders
// ─────────────────────────────────────────────────
/**
 * Ranked 2.0 keeps TWO separate ladders, each with its own RP:
 *
 *   1v1   chess · volley · connect · quiz 1v1
 *   FFA   quiz FFA · LMS · slayer
 *
 * so a single "your rank" number would be a lie. Both are drawn, each with
 * its own division progress bar.
 *
 * Reads GET /api/profile/me under the SAME react-query key the sidebar uses
 * (`SOCIAL_KEYS.me`), so opening this panel costs no extra request and the
 * two surfaces can never disagree about your rank.
 *
 * Renders NOTHING at all when signed out or when the request fails — a
 * missing rank strip is better than a fake one, and the stats below stand
 * on their own.
 */
function RankStrip() {
  const signedIn = hasAuthToken()

  const query = useQuery({
    queryKey: SOCIAL_KEYS.me,
    queryFn: profileApi.me,
    enabled: signedIn,
    staleTime: 30_000,
  })

  const me = query.data
  if (!signedIn || !me) return null

  // `rankRpOf` prefers the Ranked 2.0 field and falls back to the legacy
  // mirror column — see the note at the top of lib/api.ts.
  const rp1v1 = rankRpOf(me)
  const rpFfa = rankRpOf({ rp: me.rpFfa, elo: me.eloFfa })
  if (rp1v1 === null && rpFfa === null) return null

  return (
    <div className="mx-4 mt-4 space-y-3 rounded-xl border border-[#00ffd1]/20 bg-black/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] uppercase tracking-[0.2em] text-[#00ffd1]/60">
          Ranked
        </span>
        {typeof me.season === 'number' && (
          <span className="text-[9px] uppercase tracking-[0.16em] text-white/30">
            Season {me.season}
          </span>
        )}
      </div>

      {rp1v1 !== null && (
        <RankMeter rank={getRankInfo(rp1v1)} ladderLabel="1v1" />
      )}
      {rpFfa !== null && <RankMeter rank={getRankInfo(rpFfa)} ladderLabel="FFA" />}

      <p className="text-[9px] uppercase leading-relaxed tracking-wider text-white/30">
        RP moves on ranked online matches only — practice, local and computer
        games never touch it.
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────
// VIEWS
// ─────────────────────────────────────────────────

/** Combined = the same GameStats shape, totalled across every game. */
function CombinedView({
  combined,
  gameCount,
}: {
  combined: GameStats
  gameCount: number
}) {
  const hasRanked = combined.rankedMatches > 0

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <StatTile
          label="Matches"
          value={formatCount(combined.matches)}
          caption={`${gameCount} ${gameCount === 1 ? 'game' : 'games'} played`}
        />
        <StatTile
          label="Win rate"
          value={formatPercent(combined.winRate)}
          caption={
            hasRanked
              ? `${formatCount(combined.rankedMatches)} ranked`
              : unrankedCaption(combined)
          }
          accent={hasRanked}
        />
        <StatTile
          label="Record"
          value={`${formatCount(combined.wins)}-${formatCount(
            combined.losses
          )}-${formatCount(combined.draws)}`}
          caption="win · loss · draw"
        />
        <StatTile
          label="K/D"
          value={combined.tracksKd ? formatKd(combined.kd) : '—'}
          caption={
            combined.tracksKd
              ? `${formatCount(combined.kills)} kills · ${formatCount(
                  combined.deaths
                )} deaths`
              : 'not tracked'
          }
          accent={combined.tracksKd}
        />
      </div>

      {!combined.tracksKd && (
        <Note>
          K/D is tracked in Neon Pug Shooter, Neon Asteroids and Neon Cells.
        </Note>
      )}

      {unrankedLabel(combined) && (
        <Note>
          {unrankedLabel(combined)} of this total — kills and deaths only, no
          win rate.
        </Note>
      )}
    </div>
  )
}

/** One game's card in the PER GAME view. */
function GameCard({ stats }: { stats: GameStats }) {
  // Cells/Asteroids free play AND slayer write rows with no win condition at
  // all — a player can have matches here and still have no win rate.
  const noRanked = stats.rankedMatches === 0

  return (
    <div className="rounded-xl border border-[#00ffd1]/20 bg-black/40 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-bold tracking-wide text-white">
          {gameLabel(stats.gameKey)}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-white/35">
          {matchesLabel(stats.matches)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <StatTile
          label="Win rate"
          value={formatPercent(stats.winRate)}
          caption={
            noRanked
              ? unrankedCaption(stats)
              : `${stats.wins}W · ${stats.losses}L · ${stats.draws}D`
          }
          accent={!noRanked}
        />
        {/* K/D only where it means something (server-flagged). */}
        {stats.tracksKd && (
          <StatTile
            label="K/D"
            value={formatKd(stats.kd)}
            caption={`${formatCount(stats.kills)} · ${formatCount(
              stats.deaths
            )}`}
            accent
          />
        )}
      </div>

      {unrankedLabel(stats) && (
        <p className="mt-2 text-[9px] uppercase tracking-wider text-white/30">
          {unrankedLabel(stats)} — no win rate
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────
// SMALL PIECES
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
      className={`flex-1 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition-all cursor-pointer ${
        active
          ? 'border-[#00ffd1] bg-[#00ffd1]/15 text-[#00ffd1] shadow-[0_0_12px_rgba(0,255,209,0.35)]'
          : 'border-[#00ffd1]/25 text-white/50 hover:text-white/80'
      }`}
    >
      {label}
    </button>
  )
}

function StatTile({
  label,
  value,
  caption,
  accent = false,
}: {
  label: string
  value: string
  caption?: string
  accent?: boolean
}) {
  return (
    <div className="rounded-lg border border-[#00ffd1]/15 bg-black/40 p-2.5">
      <div className="text-[9px] uppercase tracking-[0.18em] text-[#00ffd1]/60">
        {label}
      </div>
      <div
        className={`mt-1 text-lg font-black tracking-tight ${
          accent ? 'text-[#00ffd1]' : 'text-white'
        }`}
      >
        {value}
      </div>
      {caption && (
        <div className="mt-0.5 truncate text-[9px] uppercase tracking-wider text-white/35">
          {caption}
        </div>
      )}
    </div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-[#00ffd1]/10 bg-[#00ffd1]/5 p-2.5 text-[10px] leading-relaxed text-white/45">
      {children}
    </p>
  )
}

function LoadingBlock() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading stats">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-xl border border-[#00ffd1]/10 bg-[#00ffd1]/5"
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
        Stats unavailable
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
        No stats yet
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-white/50">
        Play an online match and your record shows up here — win rate for every
        game with a winner (Slayer and free play have none), plus K/D for Pug
        Shooter, Asteroids and Cells.
      </p>
    </div>
  )
}
