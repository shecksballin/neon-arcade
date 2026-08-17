/**
 * CURRENCY — the player's chosen DISPLAY currency
 * ================================================
 * One provider, mounted at the root next to NeonBucksProvider, that answers
 * two questions for the whole app:
 *
 *   "what currency does this player want to see?"   → `currency`
 *   "what is X SOL worth in it right now?"          → `fromSol(x)` / `formatSol(x)`
 *
 * DISPLAY ONLY. The wallet is Solana, balances are read in SOL, and every
 * server-side amount stays in SOL — this changes the label on the number,
 * never the number that moves. Practice Neon Bucks are untouched too; they
 * are a game token, not money.
 *
 * Rates are fetched once (all currencies in a single request) and cached in
 * localStorage, so switching from AUD to NGN is instant and offline-safe.
 * Every consumer gets an explicit `status`, and every formatter degrades to
 * plain SOL rather than rendering a wrong or blank amount.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import {
  CURRENCIES,
  RATE_TTL_MS,
  SOL_CODE,
  currencyByCode,
  currencySymbol,
  fetchSolRates,
  formatCurrency,
  formatSol,
  guessCurrencyCode,
  isFresh,
  isSupportedCurrency,
  loadCachedRates,
  rateFor,
  type CurrencyDef,
  type FormatOptions,
  type RateTable,
} from './lib/currency'

const STORAGE_KEY = 'neon_display_currency_v1'

/**
 * `loading` only ever shows on a cold first load — with a cached table we
 * jump straight to `stale` and repaint to `ready` when the refetch lands.
 */
export type RateStatus = 'loading' | 'ready' | 'stale' | 'error' | 'native'

interface CurrencyContextValue {
  /** The selected currency (never null — SOL is the fallback). */
  currency: CurrencyDef
  /** Every currency the picker may offer. */
  currencies: CurrencyDef[]
  /** Persist a new choice. Unknown codes are ignored. */
  setCurrency: (code: string) => void

  /** Units of `currency` per 1 SOL — 1 when SOL, null when unknown. */
  rate: number | null
  status: RateStatus
  /** epoch ms of the rate table in use, or null. */
  updatedAt: number | null
  /** Force a rate refetch (the settings panel's refresh button). */
  refresh: () => Promise<void>

  /** SOL → the chosen currency, or null when no rate is available. */
  fromSol: (sol: number) => number | null
  /**
   * SOL → a ready-to-render string in the chosen currency, falling back to
   * a SOL-denominated string whenever a rate isn't available.
   */
  formatSolAs: (sol: number, opts?: FormatOptions) => string
  /** Format a number that is ALREADY in the chosen currency. */
  format: (amount: number, opts?: FormatOptions) => string
  /** `A$` / `₦` / `◎` for the chosen currency. */
  symbol: string
  /** True while the chosen currency is SOL itself (no conversion happening). */
  isNative: boolean
}

const Ctx = createContext<CurrencyContextValue | null>(null)

/** Stored choice → a currency. First run guesses from the browser locale. */
function loadCurrencyCode(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && isSupportedCurrency(saved)) return saved.toUpperCase()
  } catch {
    /* private mode — fall through to the guess */
  }
  return guessCurrencyCode()
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [code, setCode] = useState<string>(loadCurrencyCode)
  // Seed from cache — even an old table beats an empty balance while the
  // network call is in flight.
  const [table, setTable] = useState<RateTable | null>(loadCachedRates)
  const [failed, setFailed] = useState(false)

  const currency = currencyByCode(code)

  // The freshness check has to read the CURRENT table, not the one captured
  // when a timer or listener was installed — hence a ref alongside state.
  const tableRef = useRef<RateTable | null>(table)
  tableRef.current = table

  // One in-flight fetch at a time; a second caller awaits the first.
  const inFlight = useRef<Promise<void> | null>(null)

  const load = useCallback(async (force: boolean) => {
    if (inFlight.current) return inFlight.current
    if (!force && isFresh(tableRef.current)) return

    const run = (async () => {
      try {
        const next = await fetchSolRates()
        tableRef.current = next
        setTable(next)
        setFailed(false)
      } catch (err) {
        // Keep whatever table we already have — a failed refresh must not
        // wipe a working balance off the screen.
        console.warn('[currency] rate fetch failed:', err)
        setFailed(true)
      } finally {
        inFlight.current = null
      }
    })()

    inFlight.current = run
    return run
  }, [])

  // Fetch on mount (unless the cache is fresh), then keep it warm while the
  // tab is open. `visibilitychange` covers the laptop-lid case, where the
  // interval fired against a sleeping tab — both paths no-op on a table
  // that is still inside its TTL.
  useEffect(() => {
    void load(false)

    const tick = window.setInterval(() => void load(false), RATE_TTL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(false)
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      window.clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  // Another tab changed the preference — follow it, so the sidebar in one
  // window can't disagree with the settings panel in another.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return
      if (isSupportedCurrency(e.newValue)) setCode(e.newValue.toUpperCase())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setCurrency = useCallback((next: string) => {
    if (!isSupportedCurrency(next)) return
    const upper = next.toUpperCase()
    setCode(upper)
    try {
      localStorage.setItem(STORAGE_KEY, upper)
    } catch {
      /* preference just won't survive a reload */
    }
  }, [])

  const refresh = useCallback(async () => {
    await load(true)
  }, [load])

  const value = useMemo<CurrencyContextValue>(() => {
    const isNative = currency.code === SOL_CODE
    const rate = rateFor(table, currency.code)

    // No rate yet is only an ERROR once a fetch has actually failed (or a
    // table came back without this currency in it); until then it's still
    // loading. A rate we have but haven't been able to refresh is `stale`.
    const status: RateStatus = isNative
      ? 'native'
      : rate === null
        ? failed || table !== null
          ? 'error'
          : 'loading'
        : isFresh(table)
          ? 'ready'
          : 'stale'

    const fromSol = (sol: number): number | null => {
      if (!Number.isFinite(sol)) return null
      if (isNative) return sol
      // Zero is zero in every currency — answering it without a rate keeps
      // an empty balance from flickering through SOL on a cold load.
      if (sol === 0) return 0
      return rate === null ? null : sol * rate
    }

    const formatSolAs = (sol: number, opts: FormatOptions = {}): string => {
      const converted = fromSol(sol)
      // No rate → say it in SOL. Wrong money is worse than unfamiliar money.
      if (converted === null) return formatSol(sol, opts)
      return formatCurrency(converted, currency.code, opts)
    }

    return {
      currency,
      currencies: CURRENCIES,
      setCurrency,
      rate,
      status,
      updatedAt: table?.fetchedAt ?? null,
      refresh,
      fromSol,
      formatSolAs,
      format: (amount, opts) => formatCurrency(amount, currency.code, opts),
      symbol: currencySymbol(currency.code),
      isNative,
    }
  }, [currency, table, failed, setCurrency, refresh])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/**
 * The one way to read the display currency.
 *
 * Throws outside the provider on purpose — a silent SOL fallback would let a
 * component render the wrong currency forever without anyone noticing.
 */
export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCurrency must be used within CurrencyProvider')
  return ctx
}
