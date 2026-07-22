/**
 * API CLIENT
 * ==========
 * Typed fetch wrapper. Every backend route has a matching function here.
 * All hooks import from this — never fetch() directly in a hook.
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

// ─────────────────────────────────────────────────
// BASE FETCHER
// ─────────────────────────────────────────────────
async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('token')

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error ?? 'Request failed')
  }

  return res.json()
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

  updateUsername: (username: string) =>
    api<{ success: boolean }>('/api/profile/username', {
      method: 'PATCH',
      body: JSON.stringify({ username }),
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
