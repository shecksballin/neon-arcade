// ─────────────────────────────────────────
// GAME TYPES
// ─────────────────────────────────────────
export type GameMode   = 'snake' | 'slayer' | 'server' | '1v1'
export type MatchStatus = 'open' | 'active' | 'settling' | 'settled' | 'cancelled'
export type PlayerStatus = 'deposited' | 'active' | 'eliminated' | 'cashed_out'
export type KillReason = 'player_kill' | 'zone' | 'asteroid' | 'resign'
export type Region     = 'us-east' | 'us-west' | 'eu' | 'ap'

// ─────────────────────────────────────────
// ELO / RANK TYPES
// ─────────────────────────────────────────
export type RankTier =
  | 'Copper'
  | 'Bronze'
  | 'Silver'
  | 'Gold'
  | 'Platinum'
  | 'Emerald'
  | 'Diamond'
  | 'Champion'

export interface RankInfo {
  tier:          RankTier
  elo:           number
  progress:      number     // 0–100 within current tier
  eloToNextRank: number     // how many ELO until next rank
  isMaxRank:     boolean
  color:         string     // hex for UI
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
