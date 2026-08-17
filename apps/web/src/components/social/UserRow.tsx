/**
 * UserRow — the one way another player is drawn anywhere in the sidebar
 * =====================================================================
 * Avatar, username, rank, online dot, and an optional set of actions on the
 * RIGHT (revealed on hover for the invite button, per the design contract).
 *
 * ‼️ SECURITY: the props are `username`, `rank` and `online` — that is the
 * ENTIRE public identity of another player. There is no wallet, no id and no
 * email here, and none may ever be added.
 *
 * The avatar is derived from the username, so the same person always gets
 * the same face without the server ever storing (or leaking) anything.
 */

import type { ReactNode } from 'react'
import {
  DIVISIONS,
  RANK_COLORS,
  formatRp,
  getRankInfo,
} from '@neon/types'
import type { RankInfo, RankTier } from '@neon/types'
import { AVATAR_LIST } from '../../lib/avatars'

// ─────────────────────────────────────────────────
// AVATAR — deterministic from the username
// ─────────────────────────────────────────────────
/**
 * FNV-ish string hash → one of the arcade gamerpics. Case-insensitive so a
 * username never changes face between two differently-cased renderings.
 */
export function avatarFor(username: string): string {
  let hash = 0
  const key = username.toLowerCase()
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  }
  return AVATAR_LIST[hash % AVATAR_LIST.length]
}

// ─────────────────────────────────────────────────
// RANK DISPLAY — the shared Ranked 2.0 vocabulary
// ─────────────────────────────────────────────────
/**
 * THE ONE PLACE A RANK IS DRAWN. Everything here derives from RP via
 * `getRankInfo(rp)` in @neon/types — the badge is never stored, and no file
 * outside this block is allowed to hard-code a tier colour, a division
 * width or the "100 RP per division" number (division width VARIES by tier;
 * see the threshold comment in packages/types/src/elo.ts).
 *
 * Two levels of detail:
 *   RankChip   one line, for a row in a list  → "SILVER III · 2,240 RP"
 *   RankMeter  the full card read-out         → label, division pips and a
 *              progress bar ACROSS THE CURRENT DIVISION
 */

/**
 * Rank on one line, in the tier's own colour.
 *
 * Pass `rp` whenever the payload has it and you get the DIVISION for free
 * ("SILVER III"); with only `rank` (a bare tier, which is all some server
 * payloads carry) it degrades to "SILVER". Champion has no division, so it
 * renders as plain "CHAMPION" either way.
 */
export function RankChip({
  rank,
  rp,
  showRp = true,
}: {
  /** Tier fallback for payloads that carry no RP. */
  rank?: RankTier | null
  /** RP — the real source of the badge. Wins over `rank` when present. */
  rp?: number | null
  /** Append "· 2,240 RP". Off where the row is already tight. */
  showRp?: boolean
}) {
  const hasRp = typeof rp === 'number' && Number.isFinite(rp)
  const info = hasRp ? getRankInfo(rp as number) : null

  // Nothing to draw: no RP and no tier.
  if (!info && !rank) return null

  const tier = info?.tier ?? (rank as RankTier)
  const label = info ? info.label : tier

  return (
    // inline-flex + max-w-full so the chip still truncates inside the
    // `truncate` wrapper a row puts around it.
    <span className="inline-flex max-w-full items-center gap-1.5 text-[9px] uppercase tracking-[0.15em]">
      <span className="truncate" style={{ color: RANK_COLORS[tier] }}>
        {label}
      </span>
      {info && showRp && (
        <span className="shrink-0 tabular-nums text-white/30">
          · {formatRp(info.rp)} RP
        </span>
      )}
    </span>
  )
}

/**
 * DIVISION PIPS — five dots, V (bottom) → I (top), lit up to the division
 * the player is currently in. They make the sub-rank readable at a glance,
 * which a single progress bar cannot do.
 *
 * Champion has no divisions (`division: null`), so this renders nothing —
 * the caller shows the max-rank flourish instead.
 */
export function DivisionPips({ rank }: { rank: RankInfo }) {
  if (!rank.division) return null
  const index = DIVISIONS.indexOf(rank.division) // 0 = V … 4 = I

  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {DIVISIONS.map((division, i) => (
        <span
          key={division}
          className="h-1.5 w-1.5 rounded-full transition-colors"
          style={
            i <= index
              ? {
                  backgroundColor: rank.color,
                  boxShadow: `0 0 6px ${rank.color}`,
                }
              : { backgroundColor: 'rgba(255,255,255,0.12)' }
          }
        />
      ))}
    </span>
  )
}

/**
 * THE RANK READ-OUT used by the sidebar card and the Stats panel:
 *
 *      SILVER III · 2,240 RP            ● ● ● ○ ○
 *      ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░
 *      64 / 100 RP THIS DIVISION        360 RP TO GOLD
 *
 * ‼️ The bar measures progress WITHIN THE CURRENT DIVISION
 * (`rank.progressPct`), not across the tier — that is the whole point of
 * the Ranked 2.0 badge. `rpForDivision` is read from the rank info because
 * the width differs per tier.
 */
export function RankMeter({
  rank,
  /** e.g. "1v1" / "FFA" — printed as a small caption before the label. */
  ladderLabel,
}: {
  rank: RankInfo
  ladderLabel?: string
}) {
  return (
    <div>
      {/* "1V1  SILVER III · 2,240 RP" — wraps rather than truncating, so a
          long badge stays readable in the 20rem drawer. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {ladderLabel && (
          <span className="shrink-0 text-[9px] uppercase tracking-[0.2em] text-white/30">
            {ladderLabel}
          </span>
        )}
        <span
          className="text-lg font-black uppercase tracking-wider"
          style={{
            color: rank.color,
            textShadow: `0 0 14px ${rank.color}55`,
          }}
        >
          {rank.label}
        </span>
        <span className="text-[11px] font-bold tabular-nums text-white/60">
          · {formatRp(rank.rp)} RP
        </span>
      </div>

      {/* Bar = progress across the CURRENT DIVISION (full at Champion).
          Pips beside it = WHICH division, V → I. */}
      <div className="mt-2.5 flex items-center gap-2">
        <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-black/60 ring-1 ring-inset ring-white/5">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{
              width: `${rank.progressPct}%`,
              background: rank.gradient,
              boxShadow: `0 0 10px ${rank.color}`,
            }}
          />
        </div>
        <DivisionPips rank={rank} />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-[9px] uppercase tracking-wider text-white/40">
        {/* Left: where you are inside the division. Right: the next TIER,
            which is the milestone players actually chase. */}
        <span className="truncate">
          {rank.isMaxRank
            ? 'Top of the ladder'
            : `${formatRp(rank.rpIntoDivision)} / ${formatRp(
                rank.rpForDivision
              )} RP in division`}
        </span>
        <span className="shrink-0 text-right">
          {rank.isMaxRank
            ? 'Max rank'
            : `${formatRp(rank.rpToNextTier)} RP → ${rank.nextTier}`}
        </span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────
// AVATAR + PRESENCE DOT
// ─────────────────────────────────────────────────
export function UserAvatar({
  username,
  online,
  size = 32,
}: {
  username: string
  online?: boolean
  size?: number
}) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <img
        src={avatarFor(username)}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        className="h-full w-full rounded-full border border-[#00ffd1]/20 bg-black/40 object-cover"
      />
      {online !== undefined && (
        <span
          title={online ? 'Online' : 'Offline'}
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#081616] ${
            online ? 'bg-green-500 shadow-[0_0_6px_#22c55e]' : 'bg-white/25'
          }`}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────
// USER ROW
// ─────────────────────────────────────────────────

export interface UserRowProps {
  /** The ONLY public identifier. */
  username: string
  /** Rank TIER from the 1v1 ladder; omitted when unknown. */
  rank?: RankTier | null
  /**
   * RP on the 1v1 ladder. Supply it wherever the payload has it and the row
   * shows the division too ("SILVER III"); without it the chip falls back to
   * the bare tier from `rank`.
   */
  rp?: number | null
  /** Presence dot. `undefined` hides the dot entirely. */
  online?: boolean
  /** Replaces the rank line (e.g. a message preview or "REQUEST SENT"). */
  subtitle?: ReactNode
  /** Opens the row (thread, profile…). Without it the row is not clickable. */
  onClick?: () => void
  /** Highlight, e.g. the conversation currently open. */
  active?: boolean
  /** Always-visible right side: unread badges, timestamps. */
  trailing?: ReactNode
  /** Right-side buttons. Hidden until hover/focus when `hoverActions`. */
  actions?: ReactNode
  /**
   * Reveal `actions` on hover (and on keyboard focus, so the invite button
   * is reachable without a mouse). This is the ONLINE FRIENDS behaviour the
   * design contract asks for.
   */
  hoverActions?: boolean
}

export function UserRow({
  username,
  rank,
  rp,
  online,
  subtitle,
  onClick,
  active = false,
  trailing,
  actions,
  hoverActions = false,
}: UserRowProps) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors ${
        active
          ? 'border border-[#00ffd1]/40 bg-[#00ffd1]/10'
          : 'border border-transparent hover:bg-white/5'
      }`}
    >
      {/* The identity half. A <button> only when there is something to open —
          a disabled button keeps the markup identical without faking a click
          target (and never nests a button inside a button). */}
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={`flex min-w-0 flex-1 items-center gap-3 text-left ${
          onClick ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        <UserAvatar username={username} online={online} />
        <div className="min-w-0 flex-1">
          {/* React escapes this — usernames are server-validated to
              [A-Za-z0-9_]{3,20}, but we still never inject markup. */}
          <div className="truncate text-sm tracking-wide text-white/90">
            {username}
          </div>
          <div className="truncate">
            {subtitle ?? <RankChip rank={rank} rp={rp} />}
          </div>
        </div>
      </button>

      {trailing}

      {actions && (
        <div
          className={`flex shrink-0 items-center gap-1 ${
            hoverActions
              ? // `[@media(hover:none)]:opacity-100` is load-bearing, not a
                // nicety: Tailwind v4 compiles `group-hover:` inside
                // `@media (hover: hover)`, so on a phone the reveal can never
                // fire — and `group-focus-within` cannot save it either,
                // because the only focusable sibling is the row's own button,
                // whose click navigates away. Without this line every
                // hover-revealed action (invite, JOIN) is unreachable on touch.
                'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
              : ''
          }`}
        >
          {actions}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────
// ROW BUTTON — the small square action buttons on the right
// ─────────────────────────────────────────────────
export function RowButton({
  label,
  onClick,
  disabled = false,
  tone = 'neon',
  children,
}: {
  /** Accessible name + tooltip (the buttons are icon-only). */
  label: string
  onClick: () => void
  disabled?: boolean
  tone?: 'neon' | 'danger'
  children: ReactNode
}) {
  const toneClasses =
    tone === 'danger'
      ? 'border-red-400/30 text-red-300/80 hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-300'
      : 'border-[#00ffd1]/30 text-[#00ffd1]/80 hover:border-[#00ffd1]/60 hover:bg-[#00ffd1]/10 hover:text-[#00ffd1]'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClasses}`}
    >
      {children}
    </button>
  )
}
