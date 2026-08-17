/**
 * CURRENCY SELECTOR
 * =================
 * The settings surface for the display-currency preference: a searchable
 * list of everything `CURRENCIES` offers, a live "1 SOL ≈ …" preview, and
 * an honest line about where the number came from and how old it is.
 *
 * Picking applies IMMEDIATELY (and persists) — it is a preference, not part
 * of the profile form's Apply Changes, so there is nothing to submit and
 * nothing to lose by closing the panel.
 */

import { useMemo, useState } from 'react'
import { Check, RefreshCcw, Search } from 'lucide-react'

import { useCurrency } from '../CurrencyStore'
import { SOL_CODE, currencySymbol } from '../lib/currency'

/** "just now" / "4 min ago" — enough to judge whether a rate is trustworthy. */
function agoLabel(updatedAt: number | null): string {
  if (!updatedAt) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function CurrencySelector() {
  const { currency, currencies, setCurrency, status, updatedAt, refresh, formatSolAs } =
    useCurrency()
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return currencies
    return currencies.filter(
      (c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    )
  }, [currencies, query])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Live preview — what the choice actually does, in one line. */}
      <div className="rounded-2xl border border-[#00FFD1]/20 bg-[#00FFD1]/[0.04] p-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-mono uppercase tracking-[2px] text-[#00FFD1]/60">
            Exchange Rate
          </span>
          <button
            onClick={() => void handleRefresh()}
            disabled={refreshing || status === 'native'}
            className="p-1.5 rounded-full hover:bg-white/5 transition-colors disabled:opacity-30 cursor-pointer disabled:cursor-default"
            title="Refresh rate"
            aria-label="Refresh exchange rate"
          >
            <RefreshCcw
              className={`w-3.5 h-3.5 text-[#00FFD1] ${refreshing ? 'animate-spin' : ''}`}
            />
          </button>
        </div>

        {status === 'native' ? (
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-3xl font-black tracking-tighter text-white">◎ SOL</span>
            <span className="text-white/50 text-sm font-mono">native denomination</span>
          </div>
        ) : (
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-white/50 text-sm font-mono">◎1 SOL ≈</span>
            <span className="text-3xl font-black tracking-tighter text-white tabular-nums">
              {status === 'loading' ? '…' : status === 'error' ? '—' : formatSolAs(1)}
            </span>
          </div>
        )}

        <p className="mt-2 text-[9px] font-mono uppercase tracking-widest text-white/25">
          {status === 'native'
            ? 'Showing native SOL — no conversion applied'
            : status === 'error'
              ? 'Rate unavailable — amounts stay in SOL until it returns'
              : status === 'loading'
                ? 'Fetching the live market rate…'
                : `Live market rate · updated ${agoLabel(updatedAt)}${
                    status === 'stale' ? ' · refreshing' : ''
                  }`}
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search currency…"
          aria-label="Search currency"
          className="w-full bg-white/5 border border-white/10 rounded-2xl py-3.5 pl-11 pr-4 text-white text-sm focus:outline-none focus:border-[#00FFD1]/50 transition-all placeholder:text-white/25"
        />
      </div>

      {/* The list itself. `radiogroup` because this is ONE choice. */}
      <div
        role="radiogroup"
        aria-label="Display currency"
        className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[280px] overflow-y-auto custom-scrollbar pr-1"
      >
        {filtered.map((c) => {
          const active = c.code === currency.code
          return (
            <button
              key={c.code}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setCurrency(c.code)}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all cursor-pointer ${
                active
                  ? 'border-[#00FFD1] bg-[#00FFD1]/10 shadow-[0_0_20px_rgba(0,255,209,0.15)]'
                  : 'border-white/10 hover:border-[#00FFD1]/40 hover:bg-white/5'
              }`}
            >
              <span className="text-lg leading-none shrink-0" aria-hidden="true">
                {c.flag}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-xs font-black uppercase tracking-widest ${
                    active ? 'text-[#00FFD1]' : 'text-white/80'
                  }`}
                >
                  {c.code}
                </span>
                <span className="block text-[10px] text-white/35 truncate">{c.name}</span>
              </span>
              <span className="text-[11px] font-mono text-white/40 shrink-0">
                {currencySymbol(c.code)}
              </span>
              {active && <Check className="w-4 h-4 text-[#00FFD1] shrink-0" />}
            </button>
          )
        })}

        {filtered.length === 0 && (
          <p className="col-span-full py-6 text-center text-[10px] font-mono uppercase tracking-widest text-white/25">
            No currency matches “{query}”
          </p>
        )}
      </div>

      <p className="text-[9px] font-mono uppercase tracking-widest text-white/25 leading-relaxed">
        Display only — your wallet still holds{' '}
        <span className="text-[#00FFD1]/50">SOL</span>
        {currency.code !== SOL_CODE && ', converted at the live rate for display'}. Deposits,
        wagers and payouts are always settled in SOL.
      </p>
    </div>
  )
}
