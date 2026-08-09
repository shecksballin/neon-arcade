/**
 * API CLIENT
 * ==========
 * Typed fetch wrapper. Every backend route has a matching function here.
 * All hooks import from this — never fetch() directly in a hook.
 */

// Default matches the Hono server's port (apps/server config/env.ts)
const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3002'

// Shown when a request never reaches the server (down, restarting, no
// internet, CORS). Player-facing wording — the technical detail goes to
// the console. Exported so screens can recognise this exact failure and
// quietly retry it.
export const NETWORK_ERROR_MESSAGE =
  'Connection trouble — check your internet and try again in a moment'

/**
 * Every failed request throws this. `status` is the HTTP status code of
 * the response, or 0 when the request never reached the server at all
 * (network down, CORS, server restarting). Screens branch on it —
 * ErrorScreen turns it into a full status-code error page.
 */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// ─────────────────────────────────────────────────
// BASE FETCHER
// ─────────────────────────────────────────────────
async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('token')

  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    })
  } catch (err) {
    // Network-level failure (server down, port wrong, CORS) surfaces as
    // an opaque "Failed to fetch" — keep the technical detail for devs,
    // hand players something calmer.
    console.error(`[api] network failure for ${path} (${BASE_URL}):`, err)
    throw new ApiError(0, NETWORK_ERROR_MESSAGE)
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new ApiError(res.status, err.error ?? 'Request failed')
  }

  try {
    return await res.json()
  } catch (err) {
    // 2xx with a non-JSON body — wrong VITE_API_URL (SPA fallback page),
    // proxy or captive-portal HTML. To the player that's the same as not
    // reaching the server; the real cause goes to the console.
    console.error(`[api] non-JSON response for ${path} (${BASE_URL}):`, err)
    throw new ApiError(0, NETWORK_ERROR_MESSAGE)
  }
}

// ─────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────
export const authApi = {
  getNonce: (wallet: string) =>
    api<{ nonce: string }>(`/api/auth/nonce?wallet=${wallet}`),

  verify: (wallet: string, signature: string, nonce: string) =>
    api<{ token: string }>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ wallet, signature, nonce }),
    }),

  me: () =>
    api<{
      wallet:    string
      username:  string | null
      elo:       number
      eloFfa:    number
    }>('/api/auth/me'),
}


// ─────────────────────────────────────────────────
// MATCH
// ─────────────────────────────────────────────────
export const matchApi = {
  create: (mode: string, betAmount: number, maxPlayers: number, region?: string) =>
    api<{ matchId: string; nonce: string; depositAddress: string; amountSOL: number }>(
      '/api/match/create', {
        method: 'POST',
        body: JSON.stringify({ mode, betAmount, maxPlayers, region }),
      }
    ),

  join: (matchId: string, nonce: string) =>
    api<{ nonce: string; depositAddress: string; amountSOL: number }>(
      `/api/match/${matchId}/join`, {
        method: 'POST',
        body: JSON.stringify({ nonce }),
      }
    ),

  get: (matchId: string) =>
    api<{ match: any }>(`/api/match/${matchId}`),

  confirmDeposit: (matchId: string, txSig: string, nonce: string) =>
    api<{ success: boolean }>(`/api/match/${matchId}/deposit`, {
      method: 'POST',
      body: JSON.stringify({ txSig, nonce }),
    }),

  resign: (matchId: string) =>
    api<{ success: boolean }>(`/api/match/${matchId}/resign`, {
      method: 'POST',
    }),
}

// ─────────────────────────────────────────────────
// CASH OUT
// ─────────────────────────────────────────────────
export const cashOutApi = {
  manual: (matchId: string) =>
    api<{ payout: number; txSig: string }>(`/api/cashout/${matchId}`, {
      method: 'POST',
    }),

  setAuto: (matchId: string, kills?: number | null, minutes?: number | null, sol?: number | null) =>
    api<{ success: boolean }>(`/api/cashout/${matchId}/auto`, {
      method: 'POST',
      body: JSON.stringify({ kills, minutes, sol }),
    }),
}

// ─────────────────────────────────────────────────
// FRIENDS
// ─────────────────────────────────────────────────
export const friendsApi = {
  list: () =>
    api<{ friends: any[] }>('/api/friends'),

  send: (toWallet: string) =>
    api<{ success: boolean }>('/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ toWallet }),
    }),

  accept: (fromWallet: string) =>
    api<{ success: boolean }>('/api/friends/accept', {
      method: 'POST',
      body: JSON.stringify({ fromWallet }),
    }),

  decline: (fromWallet: string) =>
    api<{ success: boolean }>('/api/friends/decline', {
      method: 'POST',
      body: JSON.stringify({ fromWallet }),
    }),

  remove: (wallet: string) =>
    api<{ success: boolean }>(`/api/friends/${wallet}`, {
      method: 'DELETE',
    }),

  duel: (wallet: string, betAmount: number) =>
    api<{ matchId: string }>('/api/friends/duel', {
      method: 'POST',
      body: JSON.stringify({ wallet, betAmount }),
    }),

  invite: (wallet: string, matchId: string) =>
    api<{ success: boolean }>('/api/friends/invite', {
      method: 'POST',
      body: JSON.stringify({ wallet, matchId }),
    }),

  inviteLink: (matchId: string) =>
    api<{ link: string }>(`/api/match/${matchId}/invite-link`),
}

// ─────────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────────
export const messagesApi = {
  get: (withWallet: string, cursor?: string) =>
    api<{ messages: any[]; nextCursor: string | null }>(
      `/api/messages/${withWallet}${cursor ? `?cursor=${cursor}` : ''}`
    ),

  send: (toWallet: string, body: string) =>
    api<{ message: any }>('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ toWallet, body }),
    }),

  delete: (messageId: string) =>
    api<{ success: boolean }>(`/api/messages/${messageId}`, {
      method: 'DELETE',
    }),
}

// ─────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────
export const notificationsApi = {
  list: () =>
    api<{ notifications: any[] }>('/api/notifications'),

  unreadCount: () =>
    api<{ count: number }>('/api/notifications/unread-count'),

  markRead: (id: string) =>
    api<{ success: boolean }>(`/api/notifications/${id}/read`, { method: 'POST' }),

  markAllRead: () =>
    api<{ success: boolean }>('/api/notifications/read-all', { method: 'POST' }),

  setEnabled: (enabled: boolean) =>
    api<{ success: boolean }>('/api/notifications/settings', {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
}

// ─────────────────────────────────────────────────
// LEADERBOARD + PROFILE
// ─────────────────────────────────────────────────
export const profileApi = {
  get: (wallet: string) =>
    api<{ user: any; eloHistory: any[] }>(`/api/profile/${wallet}`),

  leaderboard: (mode: '1v1' | 'ffa' | 'server') =>
    api<{ players: any[] }>(`/api/leaderboard?mode=${mode}`),

  // NOTE: no updateUsername — usernames are unique, claimed once at
  // registration, and immutable thereafter.

  /** Account status for the sign-in gate: has this wallet finished setup? */
  me: () =>
    api<{
      wallet:      string
      username:    string | null
      hasPin:      boolean
      totpEnabled: boolean
      elo:         number
      eloFfa:      number
    }>('/api/profile/me'),

  /** Claim a unique username + 4-digit PIN; returns the TOTP QR to scan. */
  register: (username: string, pin: string) =>
    api<{
      username:   string
      otpauthUri: string
      qrDataUrl:  string
      secret:     string
    }>('/api/profile/register', {
      method: 'POST',
      body: JSON.stringify({ username, pin }),
    }),

  /** Prove a 6-digit code from the authenticator app to finish enrollment. */
  verifyTotp: (code: string) =>
    api<{ enabled: boolean; username: string }>('/api/profile/totp/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
}

// ─────────────────────────────────────────────────
// GIFT
// ─────────────────────────────────────────────────
export const giftApi = {
  getNonce: () =>
    api<{ nonce: string }>('/api/gift/nonce'),

  send: (toWallet: string, amountSol: number, txSig: string, nonce: string) =>
    api<{ payout: number; txSig: string }>('/api/gift', {
      method: 'POST',
      body: JSON.stringify({ toWallet, amountSol, txSig, nonce }),
    }),
}

// ─────────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────────
export const reportApi = {
  submit: (type: string, body: string, reportedWallet?: string, matchId?: string) =>
    api<{ success: boolean }>('/api/reports', {
      method: 'POST',
      body: JSON.stringify({ type, body, reportedWallet, matchId }),
    }),
}
