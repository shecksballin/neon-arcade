// ─────────────────────────────────────────
// GAME TYPES
// ─────────────────────────────────────────
export type GameMode   = 'lms' | 'slayer' | 'server' | '1v1'
export type MatchStatus = 'open' | 'active' | 'settling' | 'settled' | 'cancelled'
export type PlayerStatus = 'deposited' | 'active' | 'eliminated' | 'cashed_out'
export type KillReason = 'player_kill' | 'zone' | 'asteroid' | 'resign'
export type Region     = 'us-east' | 'us-west' | 'eu' | 'ap'

// ─────────────────────────────────────────
// RANK TYPES  (Ranked 2.0 — see elo.ts for the maths)
// ─────────────────────────────────────────
// The visible ladder is RP (Rank Points). The hidden skill layer is
// TrueSkill {mu, sigma} and NEVER appears in a client payload — it exists
// only for matchmaking and for computing the RP change.
export type RankTier =
  | 'Copper'
  | 'Bronze'
  | 'Silver'
  | 'Gold'
  | 'Platinum'
  | 'Emerald'
  | 'Diamond'
  | 'Champion'

/** Sub-rank inside a tier. V is the BOTTOM of the tier, I the top.
 *  Champion has no divisions → `null`. */
export type RankDivision = 'V' | 'IV' | 'III' | 'II' | 'I'

/** The two rating pools. Free play is unranked and belongs to neither. */
export type RankLadder = '1v1' | 'ffa'

/** Hidden TrueSkill state for one player on one ladder. SERVER ONLY —
 *  never serialize this to a client (it would expose matchmaking). */
export interface SkillRating {
  mu:    number
  sigma: number
}

/**
 * Everything the UI needs to draw a rank badge, derived from RP ALONE.
 * (Tier/division are never stored — they are a view of the RP integer.)
 */
export interface RankInfo {
  tier:           RankTier
  division:       RankDivision | null  // null === Champion (no divisions)
  rp:             number               // the player's RP, clamped at the floor
  rpIntoDivision: number               // RP earned inside the current division
  rpForDivision:  number               // width of the current division in RP
  progressPct:    number               // 0–100 across the current division
  nextTier:       RankTier | null      // null at Champion
  rpToNextTier:   number               // 0 at Champion
  color:          string               // hex for UI
  gradient:       string               // CSS gradient for rank cards
  isMaxRank:      boolean              // tier === 'Champion'
  label:          string               // "Silver III" / "Champion"

  // ── LEGACY ALIASES ────────────────────────────────────────────────
  // Kept so pre-Ranked-2.0 consumers keep compiling during the migration.
  // New code must use rp / progressPct / rpToNextTier instead.
  /** @deprecated use `rp` */
  elo:            number
  /** @deprecated use `progressPct` (this is progress across the DIVISION) */
  progress:       number
  /** @deprecated use `rpToNextTier` */
  eloToNextRank:  number
}

// ─────────────────────────────────────────
// PLAYER TYPES
// ─────────────────────────────────────────
export interface Player {
  wallet:     string
  username:   string | null
  elo:        number
  eloFfa:     number
  rank:       RankInfo
}

export interface MatchPlayer {
  wallet:     string
  username:   string | null
  currentPot: number
  kills:      number
  status:     PlayerStatus
  rank:       RankInfo
}

// ─────────────────────────────────────────
// MATCH TYPES
// ─────────────────────────────────────────
export interface Match {
  id:         string
  mode:       GameMode
  status:     MatchStatus
  totalPot:   number
  betAmount:  number
  maxPlayers: number
  players:    MatchPlayer[]
  region?:    Region
}

// ─────────────────────────────────────────
// SOCKET EVENT PAYLOADS
// Mirrors exactly what the backend emits
// ─────────────────────────────────────────
export interface KillRewardPayload {
  victim:     string
  earned:     number
  payoutMode: string
}

export interface PlayerEliminatedPayload {
  killedBy:  string
  potLost:   number
  reason:    KillReason
  respawns:  boolean
}

export interface PlayerRespawningPayload {
  killedBy:   string
  potLost:    number
  respawnPot: number
  respawns:   true
}

export interface PotUpdatePayload {
  matchId: string
  players: Array<{
    wallet:     string
    currentPot: number
    status:     PlayerStatus
  }>
}

export interface MatchSettledPayload {
  matchId: string
  winner:  string
  payout:  number
  txSig:   string
}

export interface CashOutConfirmedPayload {
  payout:    number
  txSig:     string
  trigger:   'manual' | 'auto_kills' | 'auto_time'
  kills:     number
}

export interface NotificationPayload {
  id:        string
  type:      string
  title:     string
  body:      string
  data:      Record<string, any> | null
  createdAt: string
}

export interface FriendRequestPayload {
  fromWallet: string
  username:   string | null
}

export interface DuelRequestPayload {
  fromWallet: string
  username:   string | null
  matchId:    string
  betAmount:  number
}

export interface MessagePayload {
  id:         string
  fromWallet: string
  body:       string
  createdAt:  string
}

// ─────────────────────────────────────────
// FRIEND TYPES
// ─────────────────────────────────────────
export interface Friend {
  wallet:    string
  username:  string | null
  elo:       number
  eloFfa:    number
  rank:      RankInfo
  status:    'pending' | 'accepted' | 'blocked'
  online:    boolean
}

// ─────────────────────────────────────────
// NOTIFICATION TYPES
// ─────────────────────────────────────────
export interface Notification {
  id:        string
  type:      'friend_request' | 'game_invite' | 'duel_request' | 'gift' | 'system'
  title:     string
  body:      string
  data:      Record<string, any> | null
  read:      boolean
  createdAt: string
}

// ─────────────────────────────────────────
// MESSAGE TYPES
// ─────────────────────────────────────────
export interface Message {
  id:         string
  fromWallet: string
  toWallet:   string
  body:       string
  deletedAt:  string | null
  createdAt:  string
}
