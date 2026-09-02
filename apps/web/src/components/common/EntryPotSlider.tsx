/**
 * ENTRY POT SLIDER — the real-money stake picker for on-chain wagering.
 *
 * USD-denominated ON PURPOSE, in $5 steps (the product ask: players think
 * in dollars, not SOL decimals): the slider moves $5 upward in $5
 * increments and the SOL equivalent is derived live from the same rate
 * table the currency picker uses (lib/currency.ts). The SOL number is what
 * the deposit flow will actually move (the server clamps to
 * MIN/MAX_BET_SOL server-side; the USD ceiling here keeps the range sane).
 *
 * BALANCE-AWARE: the slider reads the signed-in wallet's live SOL balance
 * (useWalletAddress + useSolBalance — the same read-only pair the wallet
 * panel uses) and caps itself at the highest $5 step the player can
 * actually afford. The remainder above that step is not dead money: at the
 * top step a CUSTOM BET input appears, letting the player stake any exact
 * amount between the top step and their full balance — $47 of balance
 * means the slider tops out at $45 and the custom field allows up to $47.
 *
 * Degraded states, deliberately distinct:
 *   - no rate table → slider still moves, SOL line says so, onChange
 *     reports sol: null ("cannot deposit yet"),
 *   - balance unknown (signed out / RPC hiccup) → un-capped slider up to
 *     maxUsd; no custom option (there is no known ceiling to unlock),
 *   - balance below the $5 minimum → slider pinned + disabled with an
 *     insufficient-balance note.
 */
import { useEffect, useMemo, useState } from 'react'
import { useWalletAddress } from '../../hooks/useWalletAddress'
import { useSolBalance } from '../../hooks/useSolBalance'
import {
  fetchSolRates,
  loadCachedRates,
  rateFor,
  type RateTable,
} from '../../lib/currency'

/** The product-spec'd step: the slider moves in $5 USD increments. */
export const ENTRY_POT_STEP_USD = 5
export const ENTRY_POT_MIN_USD = 5
export const ENTRY_POT_MAX_USD = 100

/** USD per 1 SOL from the shared rate table; null until known. */
function useUsdPerSol(): number | null {
  const [table, setTable] = useState<RateTable | null>(loadCachedRates)
  useEffect(() => {
    if (rateFor(table, 'USD')) return // cached table already has USD
    const ctrl = new AbortController()
    fetchSolRates(ctrl.signal)
      .then(setTable)
      .catch(() => {}) // offline — the component renders its fallback line
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return rateFor(table, 'USD')
}

export function EntryPotSlider({
  valueUsd,
  onChange,
  maxUsd = ENTRY_POT_MAX_USD,
  disabled = false,
}: {
  /** Current entry pot in USD (a $5 multiple from the slider, or any exact
   *  amount the custom-bet field allowed). */
  valueUsd: number
  /** Fired per change with the USD value and its SOL equivalent (null
   *  while no rate is known — treat as "cannot deposit yet"). */
  onChange: (usd: number, sol: number | null) => void
  /** Absolute ceiling regardless of balance. */
  maxUsd?: number
  disabled?: boolean
}) {
  const usdPerSol = useUsdPerSol()
  const { address } = useWalletAddress()
  const { balance: balanceSol } = useSolBalance(address)

  const toSol = (usd: number) => (usdPerSol ? usd / usdPerSol : null)

  // What the wallet holds, in USD — null until BOTH reads have landed.
  const balanceUsd =
    balanceSol !== null && usdPerSol ? balanceSol * usdPerSol : null

  // The highest $5 step the player can afford (capped by maxUsd). With no
  // known balance the slider runs to maxUsd un-capped — a ceiling invented
  // from missing data would block players the server would accept.
  const { sliderMax, canAffordMin } = useMemo(() => {
    if (balanceUsd === null) return { sliderMax: maxUsd, canAffordMin: true }
    const affordable =
      Math.floor(balanceUsd / ENTRY_POT_STEP_USD) * ENTRY_POT_STEP_USD
    return {
      sliderMax: Math.max(ENTRY_POT_MIN_USD, Math.min(maxUsd, affordable)),
      canAffordMin: balanceUsd >= ENTRY_POT_MIN_USD,
    }
  }, [balanceUsd, maxUsd])

  // The custom-bet ceiling: the player's EXACT balance (whole cents, and
  // never past maxUsd). Only meaningful once the balance is known.
  const customMaxUsd =
    balanceUsd !== null
      ? Math.min(maxUsd, Math.floor(balanceUsd * 100) / 100)
      : null

  // Custom bet unlocks at the top step, where the slider's $5 grid leaves
  // change on the table (the $47-balance / $45-step case).
  const atMax = valueUsd >= sliderMax
  const customUnlocked =
    customMaxUsd !== null && atMax && customMaxUsd > sliderMax
  const [customOpen, setCustomOpen] = useState(false)
  const [customText, setCustomText] = useState('')

  // A balance refresh can shrink the range under the current value (they
  // deposited elsewhere mid-screen, or the balance resolved late): clamp
  // back onto the affordable grid. The insufficient case clamps too — the
  // uncapped-while-unknown window lets a $45 pick precede a $3 balance,
  // and returning early there would leave the parent reporting a stake
  // the pinned-and-disabled thumb no longer shows.
  useEffect(() => {
    if (!canAffordMin) {
      if (valueUsd !== ENTRY_POT_MIN_USD) {
        onChange(ENTRY_POT_MIN_USD, toSol(ENTRY_POT_MIN_USD))
      }
      return
    }
    const ceiling = customMaxUsd ?? sliderMax
    if (valueUsd > ceiling + 1e-9) onChange(sliderMax, toSol(sliderMax))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sliderMax, customMaxUsd, canAffordMin])

  // Off the top step (slider moved back down), the custom field retires.
  useEffect(() => {
    if (!customUnlocked && customOpen) {
      setCustomOpen(false)
      setCustomText('')
    }
  }, [customUnlocked, customOpen])

  const applyCustom = () => {
    if (customMaxUsd === null) return
    const parsed = Number(customText)
    if (!Number.isFinite(parsed)) return
    // Clamp into [top step, exact balance] and keep whole cents.
    const usd =
      Math.round(Math.min(customMaxUsd, Math.max(sliderMax, parsed)) * 100) /
      100
    setCustomText(String(usd))
    onChange(usd, toSol(usd))
  }

  const insufficient = !canAffordMin
  const sol = toSol(valueUsd)

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <span className="text-xs uppercase tracking-widest text-white/50">
          Entry Pot
        </span>
        <span className="text-lg font-black text-[#00FFD1]">
          ${valueUsd % 1 === 0 ? valueUsd : valueUsd.toFixed(2)}
          <span className="ml-2 text-xs font-mono font-normal text-white/45">
            {sol !== null ? `≈ ◎${sol.toFixed(4)}` : 'SOL rate unavailable'}
          </span>
        </span>
      </div>

      <input
        type="range"
        min={ENTRY_POT_MIN_USD}
        max={sliderMax}
        step={ENTRY_POT_STEP_USD}
        // A custom (off-grid) value renders the thumb at the top step.
        value={Math.min(valueUsd, sliderMax)}
        disabled={disabled || insufficient}
        onChange={(e) => {
          const usd = Number(e.target.value)
          onChange(usd, toSol(usd))
        }}
        className="w-full accent-[#00FFD1] bg-[#111E1E] rounded-lg appearance-none h-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        aria-label="Entry pot in US dollars, five dollar steps"
        // The POT is the announced value, even when it sits off-grid above
        // the pinned thumb (a $47 custom bet on a $45 top step) — without
        // this a screen reader would read the label's pot and the thumb's
        // step as two disagreeing numbers on one control.
        aria-valuetext={`${valueUsd % 1 === 0 ? valueUsd : valueUsd.toFixed(2)} dollars`}
      />

      {/* The step is part of the product spec — say it, so a player knows
          why the thumb snaps. The right label doubles as the balance cap. */}
      <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-white/30">
        <span>${ENTRY_POT_MIN_USD}</span>
        <span>$5 steps</span>
        <span>
          ${sliderMax}
          {balanceUsd !== null && sliderMax < maxUsd ? ' (balance)' : ''}
        </span>
      </div>

      {insufficient && (
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#FF6B9A]/80">
          Balance ${balanceUsd?.toFixed(2)} — below the ${ENTRY_POT_MIN_USD}{' '}
          minimum
        </p>
      )}

      {/* CUSTOM BET — the change the $5 grid can't reach ($45 step on a
          $47 balance). Only shown at the top step, only when the balance
          actually exceeds it. */}
      {customUnlocked && !customOpen && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setCustomOpen(true)
            setCustomText(String(customMaxUsd))
          }}
          className="w-full py-2 rounded-lg border border-[#00FFD1]/30 font-mono text-[10px] uppercase tracking-[0.25em] text-[#00FFD1]/80 hover:text-[#00FFD1] hover:border-[#00FFD1]/70 transition-all cursor-pointer disabled:opacity-40"
        >
          Custom bet — up to ${customMaxUsd?.toFixed(2)}
        </button>
      )}
      {customUnlocked && customOpen && (
        <div className="flex items-center gap-2">
          <span className="font-black text-[#00FFD1]">$</span>
          <input
            type="number"
            inputMode="decimal"
            min={sliderMax}
            max={customMaxUsd ?? undefined}
            step={0.01}
            value={customText}
            disabled={disabled}
            onChange={(e) => setCustomText(e.target.value)}
            onBlur={applyCustom}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyCustom()
            }}
            className="flex-1 bg-[#111E1E] border border-[#00FFD1]/30 rounded-lg px-3 py-2 text-sm font-bold text-white focus:border-[#00FFD1] focus:outline-none"
            aria-label={`Custom entry pot between ${sliderMax} and ${customMaxUsd} dollars`}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (customMaxUsd === null) return
              setCustomText(String(customMaxUsd))
              onChange(customMaxUsd, toSol(customMaxUsd))
            }}
            className="px-3 py-2 rounded-lg border border-[#00FFD1]/40 font-mono text-[10px] uppercase tracking-[0.2em] text-[#00FFD1] hover:bg-[#00FFD1]/10 transition-all cursor-pointer disabled:opacity-40"
          >
            Max
          </button>
        </div>
      )}
    </div>
  )
}
