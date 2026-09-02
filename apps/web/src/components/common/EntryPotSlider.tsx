/**
 * ENTRY POT SLIDER — the real-money stake picker for on-chain wagering.
 *
 * USD-denominated ON PURPOSE, in $5 steps (the product ask: players think
 * in dollars, not SOL decimals): the slider moves $5 → $MAX in $5
 * increments and the SOL equivalent is derived live from the same rate
 * table the currency picker uses (lib/currency.ts — cached table first,
 * refetched when missing). The SOL number is what the deposit flow will
 * actually move (server clamps to MIN/MAX_BET_SOL server-side; the USD
 * ceiling here just keeps the slider's range sane).
 *
 * Rates unavailable (fresh install, offline): the slider still moves, the
 * SOL line says so, and `onChange` reports `sol: null` — a caller must
 * treat that as "cannot deposit yet", never as zero.
 */
import { useEffect, useState } from 'react'
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
  /** Current entry pot in whole USD (a multiple of the $5 step). */
  valueUsd: number
  /** Fired per change with the USD value and its SOL equivalent (null
   *  while no rate is known — treat as "cannot deposit yet"). */
  onChange: (usd: number, sol: number | null) => void
  maxUsd?: number
  disabled?: boolean
}) {
  const usdPerSol = useUsdPerSol()
  const sol = usdPerSol ? valueUsd / usdPerSol : null

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <span className="text-xs uppercase tracking-widest text-white/50">
          Entry Pot
        </span>
        <span className="text-lg font-black text-[#00FFD1]">
          ${valueUsd}
          <span className="ml-2 text-xs font-mono font-normal text-white/45">
            {sol !== null ? `≈ ◎${sol.toFixed(4)}` : 'SOL rate unavailable'}
          </span>
        </span>
      </div>

      <input
        type="range"
        min={ENTRY_POT_MIN_USD}
        max={maxUsd}
        step={ENTRY_POT_STEP_USD}
        value={valueUsd}
        disabled={disabled}
        onChange={(e) => {
          const usd = Number(e.target.value)
          onChange(usd, usdPerSol ? usd / usdPerSol : null)
        }}
        className="w-full accent-[#00FFD1] bg-[#111E1E] rounded-lg appearance-none h-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        aria-label={`Entry pot in US dollars, five dollar steps, currently ${valueUsd} dollars`}
      />

      {/* The step is part of the product spec — say it, so a player knows
          why the thumb snaps. */}
      <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-white/30">
        <span>${ENTRY_POT_MIN_USD}</span>
        <span>$5 steps</span>
        <span>${maxUsd}</span>
      </div>
    </div>
  )
}
