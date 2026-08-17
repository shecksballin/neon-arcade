# NEON ARCADE — Backend Build Handoff

> **Audience:** This document briefs the AI (or developer) building the backend. It is the single source of truth for stack choices, architecture, security protocol, and current project state. All decisions below are final unless the owner says otherwise. Where this doc conflicts with older code snippets, this doc wins.

---

## 1. Project Overview

A Solana-based multiplayer wagering game platform. Players deposit SOL, compete in skill-based games — **1v1 games:** Neon Volley, Neon Chess, Neon Checkers, Neon Fighter, Neon Quiz (1v1 mode); **free-for-all games:** Neon Cells, Neon Asteroids, Neon Quiz (FFA mode) — and winners receive payouts. The house takes a 10% fee on winnings. Reference product: damnbruh.com (similar concept, snake betting game on Solana).

There is also a fully client-side **practice mode** using a fake currency called **Neon Bucks** — already built, no backend involvement (see §9).

**Owner profile:** Solo developer, strong frontend, AI-assisted backend ("vibe coder"). Code must be readable, heavily commented, and conventional. Prefer boring, well-documented patterns over clever ones.

---

## 2. Final Stack (locked in)

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Bun** | Native TS, fast |
| Backend framework | **Hono** | BHVR stack. NOT Express — older snippets in the owner's files may show Express; migrate patterns to Hono |
| Frontend | **React + Vite** | Already owner's domain |
| ORM | **Drizzle** | Schema-first, TypeScript |
| Database | **Neon** (serverless Postgres) | Use `Pool` (WebSocket driver) on Railway, `neon` HTTP driver only in edge functions |
| Cache / presence / scaling | **Redis** | Railway one-click. Used for: presence TTLs, Socket.io Redis adapter (multi-instance), shared rate limiting |
| Real-time | **Socket.io** | Lives on Railway ONLY (Vercel is serverless, incompatible with persistent sockets) |
| Auth + wallets | **Privy** | Embedded wallet generation + social login + external wallets (Phantom etc). Server verifies Privy tokens and issues its own JWT |
| Payments | **@solana/web3.js** | Centralised model — see §3. NO Rust, NO Anchor |
| Secrets | **Doppler** | Never .env files in production. Railway has native Doppler integration |
| Monorepo | **Turborepo** | `apps/web` (Vercel) + `apps/server` (Railway) + `packages/types` (shared) |
| Validation | **Zod** | Every HTTP body and every socket payload |
| Admin panel | **Retool** | Connects to Neon with a dedicated Postgres role scoped ONLY to `reports`, `bans`, `appeals` tables. Never give Retool the main DB role |
| Deploy — frontend | **Vercel** | |
| Deploy — backend | **Railway** | Bun + Hono + Socket.io + Redis |

**Explicitly ditched:** Express (→ Hono), Anchor/Rust on-chain escrow (→ centralised), the external Solana dev (AI builds everything), raw wallet-adapter auth (→ Privy).

---

## 3. Payout Architecture — Centralised Server-Side Distribution

**Final decision. Not on-chain escrow.**

- The **house wallet** (a Solana keypair the server controls) receives all deposits and sends all payouts via `@solana/web3.js` `SystemProgram.transfer`.
- The **database is the source of truth** for who is owed what (`matchPlayers.currentPot`).
- No smart contracts anywhere. Entire backend is TypeScript.

```
Player deposits → house wallet (verified on-chain by server)
Game plays out  → DB tracks pots per player
Payout trigger  → server sends SOL from house wallet → player
```

**House wallet rules (non-negotiable):**
1. Private key lives ONLY in Doppler as `HOUSE_WALLET_PRIVATE_KEY` (JSON array format). Never in code, never in git.
2. Hot wallet holds operational float only (~20–50 SOL). A daily cron sweeps profits to a cold wallet (`COLD_WALLET_ADDRESS`).
3. Before every payout, check house balance. If `balance - payout < MINIMUM_RESERVE` (5 SOL), abort and alert the owner.
4. Alert (email/log) on: single payout above a threshold, >N payouts per minute, balance below reserve, any unhandled exception in the wager engine.

---

## 4. Core Architecture — The Wager Engine Pattern

Three-layer separation. This pattern already exists in draft code the owner has; preserve it.

```
Game code (per game)        → reports EVENTS only ("killer X killed victim Y")
                              zero financial logic, zero DB queries, zero SOL amounts

gameConfigs.ts              → one MatchConfig object per game mode
                              defines the RULES (payout mode, entry fee, caps, flags)

wagerEngine.ts              → calculates MONEY from rules + DB state
                              never trusts amounts from game code
                              always reads pots from the DB
                              owns all sendPayout() calls

useGameWager(config, io)    → hook factory giving game servers clean named methods:
                              onKill, onEnvironmentKill, onMatchEnd, onCashOut,
                              onSetAutoCashOut, onCancel, getState
```

Adding a new game = add one config + wire socket events to hooks. The engine never changes.

### MatchConfig shape

```ts
interface MatchConfig {
  matchId: string
  gameMode: string              // 'freeplay' | 'snake' | 'slayer' | '1v1' | 'quiz_ffa'
  payoutMode: 'steal' | 'accumulate' | 'survivor'
  distributeAtEnd: boolean      // slayer = true (everyone paid by kill count when last man stands)
  respawnOnDeath: boolean       // freeplay = true
  eloTracked: boolean
  entryFee: number              // SOL
  maxBet: number                // hard cap enforced by engine
  allowCashOut: boolean         // freeplay only
  houseOnEnvKill: boolean       // zone/asteroid death → house takes pot
  minPlayers: number            // snake/slayer lobbies fill dynamically (10–100)
  maxPlayers: number
  region?: string               // freeplay: 'us-east' | 'us-west' | 'eu' | 'ap'
}
```

---

## 5. Game Modes (final mechanics)

### 1v1 games — Neon Volley, Neon Chess, Neon Checkers, Neon Fighter, Neon Quiz (1v1)
- Both players deposit the buy-in; winner takes the combined pot minus house fee.
- Only **wins** count toward 1v1 ELO.
- Created via friend duel requests, open lobbies, or custom games.

### FFA games — Neon Cells and Neon Asteroids
Both share the same three wagering modes. Mechanics identical between the two games; only visuals differ.

#### Free Play (permanent servers, multi-region)
- Infinite play time, like agar.io. Regions: us-east, us-west, eu, ap.
- Kill = **steal the victim's entire pot**; you can equally have yours stolen.
- **Death = lose your whole pot and respawn at entry fee** (a real setback; killer takes the pot, house takes its fee cut). `respawnOnDeath: true`.
- Environment kill (asteroid/zone) = house takes the pot, NO respawn — player leaves the server.
- **Cash out, two paths:**
  1. **Preset in lobby:** before loading in, player sets a SOL cash-out amount; a 5-second poller auto-cashes them out the moment their pot reaches it.
  2. **Manual in game:** hold the cash-out button for 3 seconds (holding hinders gameplay).
- Kills count toward FFA ELO **per kill, incrementally** (no match end exists). Lighter K factor (12).

#### Snake mode (lobby)
- Lobby of **10–100 players** — fills dynamically depending on queue length; define `minPlayers` (start threshold) and `maxPlayers` (100) per lobby tier.
- Kill = **steal the victim's entire pot**, exactly like Free Play.
- Match ends at **last man standing** — the survivor keeps everything they've accumulated. One payout, at match end, to the winner.
- `payoutMode: 'steal'`, `distributeAtEnd: false`.

#### Slayer mode (lobby)
- Same matchmaking/lobby sizing as snake (10–100, queue-dependent).
- **What you kill is what you get:** each kill banks one entry fee into your tally (buy-in $10, 3 kills = $30), even if you die early.
- **Nobody is paid mid-match.** When the last man is standing, the match ends and **everyone is distributed SOL according to their kill count** in one settlement pass. `distributeAtEnd: true`, `payoutMode: 'accumulate'`.
- The survivor gets no bonus beyond their own kills.
- Engine note: at settle, iterate all `matchPlayers`, payout = `kills × entryFee × (1 − fee)` per player; remainder (env-kill pots, unclaimed entry fees) goes to `houseTotal`. Single `settling` lock covers the whole distribution; record one payout row per player.

### Neon Quiz — FFA mode
- Lobby format, everyone pays the buy-in.
- No kills/stealing: **winner is the player with the most correct answers, ties broken by answer speed** (track cumulative answer time server-side).
- Winner takes the pot minus house fee at match end. `payoutMode: 'survivor'`-style single settle.
- Anti-cheat note: questions and correct answers must NEVER be sent to the client before the answer window closes — validate answers server-side with server timestamps.

### Environment kills (Cells/Asteroids, all modes)
Zone and asteroid deaths route the victim's full pot to the house — no fee split, house takes 100%.

### Resign
- 1v1: opponent automatically wins, gets the full combined pot payout.
- FFA modes: house keeps the resigner's pot (in slayer, the resigner also forfeits their banked kills).

### Buy-in limits
Lobbies are created at fixed buy-ins (e.g. $10, $20, $30 tiers in SOL equivalents). Enforce `entryFee` at join and `maxBet` as a hard engine-side cap on any single credit.

### Environment kills (all modes)
Zone and asteroid deaths route the victim's full pot to the house — no fee split, house takes 100%.

### Resign
- 1v1: opponent automatically wins, gets the full combined pot payout.
- FFA/slayer/snake/server: house keeps the resigner's pot.

### Buy-in limits
Lobbies are created at fixed buy-ins (e.g. $10, $20, $30 tiers in SOL equivalents). Enforce `entryFee` at join and `maxBet` as a hard engine-side cap on any single credit.

---

## 6. ELO & Ranks

- **1v1 ELO** (`users.elo`): standard ELO, K=32, wins/losses only. Updated once at match settle. Applies to all 1v1 games including Quiz 1v1.
- **FFA ELO** (`users.eloFfa`): kills AND placement matter. K=16. Kill ELO = 8/kill × placement multiplier (1st = 2.0x, top 10% = 1.5x, top 25% = 1.2x, rest 1.0x). Updated at match end for snake/slayer. For Quiz FFA, substitute correct answers for kills and final standing for placement.
- **Free Play**: incremental per-kill ELO into `eloFfa`, K=12, standard expected-score formula per kill. No placement (no match end).
- ELO floor: 100. Every change logged to `eloHistory`.

**Ranks — every 100 ELO is one rank up:**

| Rank | ELO |
|---|---|
| Copper | 0 |
| Bronze | 100 |
| Silver | 200 |
| Gold | 300 |
| Platinum | 400 |
| Emerald | 500 |
| Diamond | 600 |
| Champion | 700+ |

Frontend already has `getRankInfo(elo)` returning tier, progress %, ELO-to-next-rank, and rank colors. Keep the backend consistent with these thresholds.

---

## 7. Security Protocol (all mandatory)

### Deposits — never trust the client
1. Server issues a one-time **nonce** (2-minute expiry, stored in `nonces` table, atomically consumed on use).
2. Client sends SOL to house wallet, returns the tx signature.
3. Server verifies on-chain via `getParsedTransaction` at `confirmed` commitment: tx exists, didn't fail, is recent (< 2 min), sender matches the authenticated wallet, amount landed in the house wallet address. Retry up to 10× (2s apart) for indexing lag.
4. `deposits.txSig` has a UNIQUE constraint — the same transaction can never be credited twice.

### Payouts — double-payout protection
- Atomic status transition: `UPDATE matches SET status='settling' WHERE id=? AND status='active' RETURNING *`. If no row returns, someone else is settling — abort.
- Sequence: claim (`settling`) → send SOL → record (`settled` + txSig) inside a Drizzle transaction.
- Orphaned `settling` rows (server crashed mid-payout) are surfaced for manual review — never auto-retried blindly.
- Payout amounts are ALWAYS read from the DB (`currentPot`), never from request bodies or socket payloads.

### Auth
- Privy handles login (embedded wallets + social + external wallets). Server verifies the Privy auth token, then issues its own short-lived JWT containing `{ wallet }`.
- Every Hono route uses `requireAuth` middleware. Every socket connection authenticates via JWT in `handshake.auth`; the verified wallet is attached as `socket.data.wallet`.
- **The authenticated identity is ALWAYS `socket.data.wallet` / `req.wallet` (from JWT). Wallet addresses in payloads are never trusted for identity.**

### Input validation
- Zod schema on every HTTP body and every socket event payload. `safeParse`, reject on failure, use only `parsed.data` afterward.
- Wallet strings: length 44. Match IDs: UUID. Amounts: min/max bounds server-side.

### Rate limiting
- Per-wallet (fall back to IP): auth 10/15min, general API 60/min, lobby creation 10/min, payout/cashout 5/min.
- Sockets: heartbeat min-interval 10s; per-IP connection caps (10 for anonymous presence, 3 for authed game sockets); `maxHttpBufferSize` kept small.
- Shared limits go through Redis once running multiple instances.

### Bans
- `bans` table checked in a Hono middleware on every authed request and on socket connect. Banned wallets get 403 + socket rejection. Appeals via `appeals` table, managed in Retool.

### Presence (already designed)
- Anonymous page-visitor count needs NO auth: server issues its own `randomUUID()` session id, presence keyed in Redis with a 30s TTL, heartbeat every 20s, per-IP cap 10, broadcast aggregate count only every 5s. Use Redis `SCAN` (never `KEYS`).

### Misc
- CORS: exact `CLIENT_ORIGIN`, never `*`.
- HTTPS everywhere (Railway/Vercel provide it).
- No personal data beyond wallet addresses and chosen usernames.

---

## 8. Database Schema (Drizzle — already drafted)

Tables the owner has draft schemas for (preserve column naming):

- `users` — wallet (PK), username, elo, eloFfa, notificationsEnabled, timestamps
- `nonces` — nonce (PK), wallet, expiresAt, usedAt
- `matches` — id, mode, gameMode (`freeplay|snake|slayer|1v1|quiz_ffa`), status (`open|active|settling|settled|cancelled`), totalPot, houseTotal, winner, txSig, minPlayers, maxPlayers, betAmount, region, timestamps
- `matchPlayers` — matchId, wallet, depositSol, currentPot, kills, status (`deposited|active|eliminated|cashed_out`), rank, eliminatedBy, autoCashOutSol (the lobby-preset SOL threshold; primary trigger — kills/minutes columns from older drafts are optional extras), timestamps
- `payouts` — matchId, wallet, amountSol, type (`win|cashout|slayer_kill|refund|gift|house`), txSig, paidAt
- `deposits` — matchId, wallet, amountSol, txSig (UNIQUE), nonce, status, timestamps
- `eloHistory` — matchId, wallet, mode, eloBefore/After/Change, kills, placement
- `notifications` — wallet, type (`friend_request|game_invite|duel_request|gift|system`), title, body, data (JSON string), read
- `friends` — requester, recipient, status (`pending|accepted|blocked`)
- `messages` — fromWallet, toWallet, body, deletedAt (soft delete only)
- `gifts` — fromWallet, toWallet, amountSol, txSig
- `reports` — reporterWallet, reportedWallet, matchId, type (`bug|cheater|inappropriate`), body, status, adminNotes
- `bans` — wallet, reason, expiresAt (null = permanent), bannedBy
- `appeals` — banId, wallet, body, status, adminNotes

---

## 9. Social & Platform Features

All of these have draft API-client functions on the frontend already (`authApi`, `matchApi`, `cashOutApi`, `friendsApi`, `messagesApi`, `notificationsApi`, `profileApi`, `giftApi`, `reportApi`). Build the Hono routes to match those signatures.

- **Friends:** request/accept/decline/remove. Socket notify on request.
- **Messaging:** Socket.io real-time + Drizzle persistence. Soft deletes only.
- **Duels:** friend sends 1v1 request → creates a match on accept.
- **Invites:** in-app friend invites, invite-to-lobby (joins friend into a specific open lobby), and shareable invite links (server-generated token).
- **Custom games:** available for ALL games — a friend creates a private lobby (any mode, any buy-in within limits, invite-only via friends list or link). Same wager engine, `matches` row flagged private with an allowlist of invited wallets enforced at join.
- **Leaderboards:** global and **per game** (each of the 8+ games has its own board), by mode where relevant.
- **Private stats:** per-game personal stats visible only to the owner — matches played, W/L, kills, SOL won/lost, ELO history per game. Add a `gameId` dimension to `eloHistory`/`matchPlayers` aggregation queries; stats endpoints require the JWT wallet to match the requested wallet.
- **Gifting:** **direct SOL**, routed through the house wallet as intermediary (deposit leg verified on-chain, payout leg sent to recipient) with the house fee applied and both legs logged. Cap: min 0.01 / max 10 SOL.
- **Notifications:** **in-app only** (no push). Socket push when online + DB persistence, unread counts, per-user enable/disable toggle.
- **Leaderboards & profiles:** by mode (1v1 / ffa / server), ELO history.
- **Reports/bans/appeals:** users file reports in-app → reviewed in Retool.

### Neon Bucks (practice mode) — DO NOT build backend for this
Fully client-side fake currency, already built (`NeonBucksStore.tsx`, localStorage-persisted React context). Practice games vs AI wager Neon Bucks with a one-time free chance for new players. **No server involvement, no real money, keep it that way.**

---

## 10. Deployment & Environments

```
Vercel   → apps/web      (React + Vite, Privy client SDK)
Railway  → apps/server   (Bun + Hono + Socket.io)
Railway  → Redis         (one-click add-on)
Neon     → Postgres      (external, both envs)
Doppler  → secrets       (native Railway integration; local dev via `doppler run -- bun dev`)
```

- Frontend talks to Railway over HTTPS (API) and WSS (sockets).
- Free Play regions: start with one Railway service; regional expansion later = one Railway service per region with region-specific match rows, all sharing Neon + using the Socket.io Redis adapter.
- Doppler secrets: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `SOLANA_RPC_URL`, `HOUSE_WALLET_ADDRESS`, `HOUSE_WALLET_PRIVATE_KEY`, `COLD_WALLET_ADDRESS`, `CLIENT_ORIGIN`, `HOUSE_FEE_PERCENT=10`, `MIN_BET_SOL`, `MAX_BET_SOL`.

---

## 11. Current Project State

**Built / drafted (exists as code the owner has):**
- Frontend games: Neon Cells, Neon Asteroids (FFA); Neon Volley, Neon Chess, Neon Checkers, Neon Fighter (1v1); Neon Quiz (1v1 + FFA)
- Neon Bucks practice currency (client-side, complete)
- Draft Drizzle schema (all tables in §8)
- Draft wager engine + `useGameWager` hook factory + game configs (Express-era drafts — port to Hono/Bun)
- Draft services: cashOutService (drafted with 3 auto triggers — simplify to the lobby-preset SOL threshold as primary), eloService (all 3 update paths), socialService (gifts/notifications/resign)
- Anonymous presence server + `useActiveUsers` hook (Socket.io + Redis, complete design)
- Frontend API client + shared types + rank utility (Copper→Champion)

**Not built yet (the job):**
1. Turborepo scaffold (`apps/web`, `apps/server`, `packages/types`)
2. Hono server: auth (Privy verification → JWT), all routes matching the frontend API client, middleware (auth, ban check, rate limits, Zod)
3. Socket.io game event handlers wired to the wager engine hooks
4. Solana payout service (sendPayout, verifyDeposit, balance checks, daily cold-wallet sweep cron)
5. Drizzle migrations against Neon
6. Free Play auto cash-out poller (SOL-threshold preset) + notification delivery
7. Retool admin setup (scoped Postgres role, reports/bans/appeals views)
8. Doppler + Railway + Vercel deployment wiring

**Suggested build order:** scaffold → schema/migrations → auth → deposit verification → wager engine port → 1v1 flow end-to-end on devnet → snake → slayer (end-of-match distribution) → free play + cash out → quiz FFA → social features (friends, messaging, custom games, leaderboards, private stats) → admin → mainnet.

**Test everything on Solana devnet before mainnet. Cap max bets low at launch.**

---

## 12. Working Style Notes for the AI

- Comment generously — the owner reads and learns from the code.
- Prefer explicit over clever. Conventional patterns. Small files with one job each.
- Never put financial logic in game code — it lives in the wager engine only.
- Never trust client-supplied amounts or identities. DB + JWT are truth.
- When something is ambiguous about money handling, STOP and ask the owner rather than assuming.
