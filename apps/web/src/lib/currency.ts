/**
 * DISPLAY CURRENCY
 * ================
 * The player picks what real-money amounts are *shown* in — AUD, USD, EUR,
 * GBP, NGN, … or SOL itself. Nothing here changes what is held or moved:
 * the wallet is always Solana, every balance is read in SOL, and this file
 * only decides how that number is painted on screen.
 *
 * Two halves:
 *   1. the currency table + Intl formatting helpers (pure, sync, offline)
 *   2. the SOL→fiat rate fetch, with a localStorage cache so switching
 *      currencies never waits on the network
 *
 * Rates come from CoinGecko's public simple-price endpoint (no key, CORS
 * enabled) in ONE request covering every supported currency, refreshed at
 * most once every RATE_TTL_MS. If it fails we fall back to the last cached
 * table, and if there isn't one, callers degrade to plain SOL — a stale or
 * missing rate must never blank out a balance.
 */

/** `SOL` is a real choice, not a placeholder: it is the native denomination. */
export const SOL_CODE = 'SOL'

export interface CurrencyDef {
  /** ISO-4217 code, or the sentinel `SOL`. */
  code: string
  name: string
  /** Flag/emoji for the picker. `◎` for SOL. */
  flag: string
  /** CoinGecko `vs_currencies` id. Empty for SOL (it is the base). */
  vs: string
}

/**
 * Curated list — every entry is a currency CoinGecko can quote SOL against,
 * so the single rate request below can never contain an unquotable code.
 * Ordered: SOL first, then the currencies players actually asked for, then
 * the rest alphabetically by name.
 */
export const CURRENCIES: CurrencyDef[] = [
  { code: 'SOL', name: 'Solana', flag: '◎', vs: '' },
  { code: 'USD', name: 'US Dollar', flag: '🇺🇸', vs: 'usd' },
  { code: 'AUD', name: 'Australian Dollar', flag: '🇦🇺', vs: 'aud' },
  { code: 'EUR', name: 'Euro', flag: '🇪🇺', vs: 'eur' },
  { code: 'GBP', name: 'British Pound', flag: '🇬🇧', vs: 'gbp' },
  { code: 'NGN', name: 'Nigerian Naira', flag: '🇳🇬', vs: 'ngn' },
  { code: 'AED', name: 'UAE Dirham', flag: '🇦🇪', vs: 'aed' },
  { code: 'ARS', name: 'Argentine Peso', flag: '🇦🇷', vs: 'ars' },
  { code: 'BDT', name: 'Bangladeshi Taka', flag: '🇧🇩', vs: 'bdt' },
  { code: 'BHD', name: 'Bahraini Dinar', flag: '🇧🇭', vs: 'bhd' },
  { code: 'BRL', name: 'Brazilian Real', flag: '🇧🇷', vs: 'brl' },
  { code: 'CAD', name: 'Canadian Dollar', flag: '🇨🇦', vs: 'cad' },
  { code: 'CHF', name: 'Swiss Franc', flag: '🇨🇭', vs: 'chf' },
  { code: 'CLP', name: 'Chilean Peso', flag: '🇨🇱', vs: 'clp' },
  { code: 'CNY', name: 'Chinese Yuan', flag: '🇨🇳', vs: 'cny' },
  { code: 'CZK', name: 'Czech Koruna', flag: '🇨🇿', vs: 'czk' },
  { code: 'DKK', name: 'Danish Krone', flag: '🇩🇰', vs: 'dkk' },
  { code: 'GEL', name: 'Georgian Lari', flag: '🇬🇪', vs: 'gel' },
  { code: 'HKD', name: 'Hong Kong Dollar', flag: '🇭🇰', vs: 'hkd' },
  { code: 'HUF', name: 'Hungarian Forint', flag: '🇭🇺', vs: 'huf' },
  { code: 'IDR', name: 'Indonesian Rupiah', flag: '🇮🇩', vs: 'idr' },
  { code: 'ILS', name: 'Israeli Shekel', flag: '🇮🇱', vs: 'ils' },
  { code: 'INR', name: 'Indian Rupee', flag: '🇮🇳', vs: 'inr' },
  { code: 'JPY', name: 'Japanese Yen', flag: '🇯🇵', vs: 'jpy' },
  { code: 'KRW', name: 'South Korean Won', flag: '🇰🇷', vs: 'krw' },
  { code: 'KWD', name: 'Kuwaiti Dinar', flag: '🇰🇼', vs: 'kwd' },
  { code: 'LKR', name: 'Sri Lankan Rupee', flag: '🇱🇰', vs: 'lkr' },
  { code: 'MXN', name: 'Mexican Peso', flag: '🇲🇽', vs: 'mxn' },
  { code: 'MYR', name: 'Malaysian Ringgit', flag: '🇲🇾', vs: 'myr' },
  { code: 'NOK', name: 'Norwegian Krone', flag: '🇳🇴', vs: 'nok' },
  { code: 'NZD', name: 'New Zealand Dollar', flag: '🇳🇿', vs: 'nzd' },
  { code: 'PHP', name: 'Philippine Peso', flag: '🇵🇭', vs: 'php' },
  { code: 'PKR', name: 'Pakistani Rupee', flag: '🇵🇰', vs: 'pkr' },
  { code: 'PLN', name: 'Polish Złoty', flag: '🇵🇱', vs: 'pln' },
  { code: 'RUB', name: 'Russian Ruble', flag: '🇷🇺', vs: 'rub' },
  { code: 'SAR', name: 'Saudi Riyal', flag: '🇸🇦', vs: 'sar' },
  { code: 'SEK', name: 'Swedish Krona', flag: '🇸🇪', vs: 'sek' },
  { code: 'SGD', name: 'Singapore Dollar', flag: '🇸🇬', vs: 'sgd' },
  { code: 'THB', name: 'Thai Baht', flag: '🇹🇭', vs: 'thb' },
  { code: 'TRY', name: 'Turkish Lira', flag: '🇹🇷', vs: 'try' },
  { code: 'TWD', name: 'Taiwan Dollar', flag: '🇹🇼', vs: 'twd' },
  { code: 'UAH', name: 'Ukrainian Hryvnia', flag: '🇺🇦', vs: 'uah' },
  { code: 'VND', name: 'Vietnamese Dong', flag: '🇻🇳', vs: 'vnd' },
  { code: 'ZAR', name: 'South African Rand', flag: '🇿🇦', vs: 'zar' },
]

export const SOL_CURRENCY = CURRENCIES[0]

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]))

/** Look a code up; unknown / legacy codes fall back to SOL rather than throw. */
export function currencyByCode(code: string | null | undefined): CurrencyDef {
  if (!code) return SOL_CURRENCY
  return BY_CODE.get(code.toUpperCase()) ?? SOL_CURRENCY
}

export function isSupportedCurrency(code: string): boolean {
  return BY_CODE.has(code.toUpperCase())
}

// ─────────────────────────────────────────────────
// LOCALE GUESS
// ─────────────────────────────────────────────────

/**
 * A same-region default so a first-time player in Sydney sees AUD, not USD.
 * Region → currency for the codes we support; anything unmapped lands on USD.
 */
const REGION_CURRENCY: Record<string, string> = {
  AU: 'AUD', US: 'USD', GB: 'GBP', NG: 'NGN', CA: 'CAD', NZ: 'NZD',
  IN: 'INR', JP: 'JPY', KR: 'KRW', CN: 'CNY', HK: 'HKD', TW: 'TWD',
  SG: 'SGD', MY: 'MYR', TH: 'THB', VN: 'VND', ID: 'IDR', PH: 'PHP',
  PK: 'PKR', BD: 'BDT', LK: 'LKR', AE: 'AED', SA: 'SAR', KW: 'KWD',
  BH: 'BHD', IL: 'ILS', TR: 'TRY', UA: 'UAH', RU: 'RUB', GE: 'GEL',
  ZA: 'ZAR', BR: 'BRL', MX: 'MXN', AR: 'ARS', CL: 'CLP', CH: 'CHF',
  SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF',
  AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR', ES: 'EUR',
  FI: 'EUR', FR: 'EUR', GR: 'EUR', IE: 'EUR', IT: 'EUR', LT: 'EUR',
  LU: 'EUR', LV: 'EUR', MT: 'EUR', NL: 'EUR', PT: 'EUR', SI: 'EUR',
  SK: 'EUR', HR: 'EUR',
}

/** Best guess at the player's currency from their browser locale. */
export function guessCurrencyCode(): string {
  try {
    for (const tag of navigator.languages ?? [navigator.language]) {
      if (!tag) continue
      const region =
        (typeof Intl.Locale === 'function' ? new Intl.Locale(tag).region : null) ??
        tag.split('-')[1]
      const code = region ? REGION_CURRENCY[region.toUpperCase()] : undefined
      if (code) return code
    }
  } catch {
    /* exotic locale string — fall through */
  }
  return 'USD'
}

// ─────────────────────────────────────────────────
// FORMATTING
// ─────────────────────────────────────────────────

export interface FormatOptions {
  /** Drop the currency symbol/code and print the bare number. */
  bare?: boolean
  /** `1.2K` / `3.4M` instead of the full number — for tight stat tiles. */
  compact?: boolean
  /** Force decimals; otherwise the currency's own convention is used. */
  maximumFractionDigits?: number
  minimumFractionDigits?: number
  /**
   * Use the SHORT symbol (`₦`, `$`) instead of the disambiguating one
   * (`NGN`, `A$`). Only for places that already state the code beside it —
   * on its own, a bare `$` cannot tell AUD from USD from SGD.
   */
  narrowSymbol?: boolean
}

/** `Intl` throws on an unsupported option combo in older engines — cache and retry. */
const formatterCache = new Map<string, Intl.NumberFormat>()
const digitsCache = new Map<string, number>()

/** A currency's own decimal convention: 2 for USD, 0 for JPY, 3 for KWD. */
function currencyFractionDigits(code: string): number {
  const hit = digitsCache.get(code)
  if (hit !== undefined) return hit
  let digits = 2
  try {
    digits =
      new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2
  } catch {
    /* unknown code — 2 is the overwhelming default */
  }
  digitsCache.set(code, digits)
  return digits
}

function getFormatter(code: string, opts: FormatOptions): Intl.NumberFormat {
  const key = `${code}|${JSON.stringify(opts)}`
  const hit = formatterCache.get(key)
  if (hit) return hit

  const base: Intl.NumberFormatOptions = {
    notation: opts.compact ? 'compact' : 'standard',
  }
  if (opts.maximumFractionDigits !== undefined) base.maximumFractionDigits = opts.maximumFractionDigits
  if (opts.minimumFractionDigits !== undefined) base.minimumFractionDigits = opts.minimumFractionDigits

  let fmt: Intl.NumberFormat
  if (opts.bare) {
    // Without `style: 'currency'` Intl loses the code's decimal convention
    // and falls back to 3 digits — put it back, or a bare AUD balance reads
    // "412.305". Skipped for compact, where "1.20K" is worse than "1.2K".
    const digits = opts.maximumFractionDigits ?? currencyFractionDigits(code)
    fmt = new Intl.NumberFormat(undefined, {
      ...base,
      maximumFractionDigits: digits,
      ...(opts.compact
        ? {}
        : { minimumFractionDigits: Math.min(opts.minimumFractionDigits ?? digits, digits) }),
    })
  } else {
    // DEFAULT (`symbol`) ON PURPOSE. It is locale-relative: to a player in
    // Sydney AUD is "$" and USD is "US$"; to one in New York it's the other
    // way round. `narrowSymbol` would collapse AUD, CAD, NZD, SGD and HKD
    // all to a bare "$" — pretty, and wrong by an order of magnitude.
    try {
      fmt = new Intl.NumberFormat(undefined, {
        ...base,
        style: 'currency',
        currency: code,
        ...(opts.narrowSymbol ? { currencyDisplay: 'narrowSymbol' as const } : {}),
      })
    } catch {
      try {
        fmt = new Intl.NumberFormat(undefined, { ...base, style: 'currency', currency: code })
      } catch {
        fmt = new Intl.NumberFormat(undefined, base)
      }
    }
  }
  formatterCache.set(key, fmt)
  return fmt
}

/** `◎ 1.2345` — SOL is not an ISO currency, so it is formatted by hand. */
export function formatSol(sol: number, opts: FormatOptions = {}): string {
  const n = Number.isFinite(sol) ? sol : 0
  const digits =
    opts.maximumFractionDigits ??
    (Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 3 : 4)
  const text = new Intl.NumberFormat(undefined, {
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: digits,
    minimumFractionDigits: opts.minimumFractionDigits ?? 0,
  }).format(n)
  return opts.bare ? text : `◎${text}`
}

/**
 * Format an amount already denominated in `code`. Sub-cent amounts keep
 * enough precision to not read as a flat zero (a 0.004 SOL pot in USD is
 * "$0.79", but in a weak currency it can be "₦0.0012" — still not "₦0").
 */
export function formatCurrency(amount: number, code: string, opts: FormatOptions = {}): string {
  if (code === SOL_CODE) return formatSol(amount, opts)
  const n = Number.isFinite(amount) ? amount : 0

  const resolved: FormatOptions = { ...opts }
  if (resolved.maximumFractionDigits === undefined && n !== 0 && Math.abs(n) < 0.01 && !opts.compact) {
    resolved.maximumFractionDigits = 6
    resolved.minimumFractionDigits = resolved.minimumFractionDigits ?? 2
  }

  try {
    return getFormatter(code, resolved).format(n)
  } catch {
    return `${n.toLocaleString()} ${code}`
  }
}

/**
 * The short symbol for a code (`$`, `€`, `₦`, `◎`) — for chips that sit next
 * to the code itself, where the "$ = which dollar?" ambiguity is already
 * resolved by the label beside it.
 */
export function currencySymbol(code: string): string {
  if (code === SOL_CODE) return '◎'
  try {
    const part = getFormatter(code, { narrowSymbol: true })
      .formatToParts(0)
      .find((p) => p.type === 'currency')
    return part?.value ?? code
  } catch {
    return code
  }
}

// ─────────────────────────────────────────────────
// SOL → FIAT RATES
// ─────────────────────────────────────────────────

/** How many units of each currency one SOL is worth. */
export type RateMap = Record<string, number>

export interface RateTable {
  /** epoch ms of the fetch that produced `rates` */
  fetchedAt: number
  rates: RateMap
  /** Which provider answered — for the "updated …" line and for debugging. */
  source?: string
}

const RATES_STORAGE_KEY = 'neon_sol_rates_v1'
/** Prices move slowly enough for a five-minute cache; keeps us far under
 *  CoinGecko's anonymous rate limit even with a tab left open all day. */
export const RATE_TTL_MS = 5 * 60 * 1000

const VS_LIST = CURRENCIES.filter((c) => c.vs).map((c) => c.vs)

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price' +
  `?ids=solana&vs_currencies=${VS_LIST.join(',')}`

/** Same data, different vendor. Quotes SOL against every ISO code at once. */
const COINBASE_URL = 'https://api.coinbase.com/v2/exchange-rates?currency=SOL'

/** Last table we persisted, however old. Stale beats blank. */
export function loadCachedRates(): RateTable | null {
  try {
    const raw = localStorage.getItem(RATES_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as RateTable
    if (
      !parsed ||
      typeof parsed.fetchedAt !== 'number' ||
      !parsed.rates ||
      typeof parsed.rates !== 'object'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function saveCachedRates(table: RateTable): void {
  try {
    localStorage.setItem(RATES_STORAGE_KEY, JSON.stringify(table))
  } catch {
    /* private mode / quota — the in-memory table still works this session */
  }
}

export function isFresh(table: RateTable | null): boolean {
  if (!table) return false
  const age = Date.now() - table.fetchedAt
  // A clock that jumped backwards would make `age` negative and pin the
  // table as "fresh" forever; treat that as stale too.
  return age >= 0 && age < RATE_TTL_MS
}

/** A rate is only kept if it is a real, positive, finite number. */
function keepRate(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** CoinGecko: one request, our whole currency list, keyed by lowercase code. */
async function fromCoinGecko(signal?: AbortSignal): Promise<RateMap> {
  const body = (await getJson(COINGECKO_URL, signal)) as { solana?: Record<string, unknown> }
  const quoted = body?.solana
  if (!quoted || typeof quoted !== 'object') throw new Error('unexpected response')

  // Key by OUR codes (AUD), not CoinGecko's (aud).
  const rates: RateMap = {}
  for (const c of CURRENCIES) {
    if (!c.vs) continue
    const value = keepRate(quoted[c.vs])
    if (value !== null) rates[c.code] = value
  }
  return rates
}

/** Coinbase: same shape of answer, uppercase ISO keys, values as strings. */
async function fromCoinbase(signal?: AbortSignal): Promise<RateMap> {
  const body = (await getJson(COINBASE_URL, signal)) as {
    data?: { rates?: Record<string, unknown> }
  }
  const quoted = body?.data?.rates
  if (!quoted || typeof quoted !== 'object') throw new Error('unexpected response')

  const rates: RateMap = {}
  for (const c of CURRENCIES) {
    if (!c.vs) continue
    const value = keepRate(quoted[c.code])
    if (value !== null) rates[c.code] = value
  }
  return rates
}

/**
 * One request for every supported currency, from the first provider that
 * answers. Two vendors because a single blocked host (ad blockers do filter
 * crypto-price domains) would otherwise take the whole feature down.
 *
 * Throws only when EVERY source failed, so callers can decide whether to
 * keep showing a stale table.
 */
export async function fetchSolRates(signal?: AbortSignal): Promise<RateTable> {
  const sources: Array<[string, (s?: AbortSignal) => Promise<RateMap>]> = [
    ['coingecko', fromCoinGecko],
    ['coinbase', fromCoinbase],
  ]

  let lastError: unknown = new Error('no rate source available')
  for (const [name, load] of sources) {
    try {
      const rates = await load(signal)
      if (Object.keys(rates).length === 0) throw new Error('empty response')
      const table: RateTable = { fetchedAt: Date.now(), rates, source: name }
      saveCachedRates(table)
      return table
    } catch (err) {
      // An abort is the caller leaving, not a provider being down — don't
      // burn the fallback on it.
      if (signal?.aborted) throw err
      console.warn(`[currency] ${name} rates failed:`, err)
      lastError = err
    }
  }
  throw lastError
}

/** Units of `code` per 1 SOL. `SOL` is 1 by definition; unknown → null. */
export function rateFor(table: RateTable | null, code: string): number | null {
  if (code === SOL_CODE) return 1
  const value = table?.rates?.[code]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}
