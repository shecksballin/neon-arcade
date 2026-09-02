# WAGERING_IMPLEMENTATION.md — Solana Wagering System Spec

> **Audience:** Claude Code, building inside the Neon Arcade Turborepo.
> **Scope of this task:** on-chain transactions (deposits + payouts), server-side result validation, security protocols, and the gifting system.
> **Out of scope for this task:** permanent servers / free-play cash-out (feature dropped), frontend UI, streaming/social features, admin panel.
>
> This doc is the contract. Where existing draft code in the repo conflicts with it, this doc wins. Where this doc is silent, follow `BACKEND_HANDOFF.md`. If a money-handling decision is ambiguous, STOP and ask the owner — never guess on anything that moves funds.

---

## 0. Context you must respect

- **Stack:** Bun + Hono on Railway. Drizzle → Neon (use the WebSocket `Pool` driver). Socket.io for realtime. Zod on every input. Secrets via Doppler → `process.env` → validated in `config/env.ts`.
- **Payout model:** centralised. One house wallet signs all outgoing SOL via `@solana/web3.js`. No Rust, no Anchor, no smart contracts.
- **Network:** devnet until the owner explicitly says otherwise. `SOLANA_RPC_URL` decides; never hardcode a cluster.
- **Auth:** Privy on the frontend → nonce signature → backend issues its own JWT containing `{ wallet }`. The verified JWT wallet is the ONLY identity source.
- **Game modes in scope:** `1v1`, `snake` (steal pots, last-man-standing wins), `slayer` (earn entry fee per kill, everyone paid by kill count at match end), `quiz_ffa` (most correct + fastest wins pot).

### Absolute rules (violating any of these is a failed task)

1. Payout amounts are ALWAYS computed from database state. Never from a request body, socket payload, or in-memory game state.
2. Identity is ALWAYS `c.get('wallet')` / `socket.data.wallet` from the verified JWT. Wallet fields in payloads are data about *other* parties, never about the sender.
3. Every money mutation uses the atomic patterns in §7. No read-then-write on balances without a row lock or SQL-level arithmetic.
4. The house wallet private key is read only in `solana/payoutService.ts` via `config`. It is never logged, never serialized, never passed as a function argument.
5. `sql.raw()` never receives user input.
6. Every HTTP body and socket payload is Zod-validated with `safeParse`; only `parsed.data` is used afterward.
7. No new dependencies without noting why in the PR description.

---

## 1. Files to create

```
apps/server/src/
├── config/env.ts                    # Zod-validated env (extend existing)
├── solana/payoutService.ts          # sendPayout, verifyDeposit, balance guard, sweep
├── services/
│   ├── nonceService.ts              # one-time nonces
│   ├── depositService.ts            # nonce → on-chain verify → credit
│   ├── wagerEngine.ts               # all money math, per-mode settlement
│   ├── giftService.ts               # gifting (two-leg transfer)
│   └── alertService.ts              # admin alerts (log + email stub)
├── validation/
│   └── gameEvents.ts                # Zod schemas + sanity checks for game events
├── routes/
│   ├── deposits.ts                  # nonce issue + deposit confirm
│   ├── gifts.ts                     # gift flow
│   └── internal.ts                  # health, house balance, orphaned queue (auth-gated)
└── jobs/
    └── sweep.ts                     # daily cold-wallet sweep
```

Existing drafts for some of these exist in the repo — port them to this structure, updating to the rules in this doc (notably: **slayer settles at match END, not on elimination** — older drafts have payoutOnElimination, which is superseded).

---

## 2. Environment (config/env.ts)

Extend the Zod schema. All values arrive via Doppler.

```ts
DATABASE_URL:               z.string().url(),
JWT_SECRET:                 z.string().min(32),
SOLANA_RPC_URL:             z.string().url(),
HOUSE_WALLET_ADDRESS:       z.string().length(44),
HOUSE_WALLET_PRIVATE_KEY:   z.string().min(2),        // JSON array string
COLD_WALLET_ADDRESS:        z.string().length(44),
CLIENT_ORIGIN:              z.string().url(),
HOUSE_FEE_PERCENT:          z.coerce.number().min(0).max(50).default(10),
MIN_BET_SOL:                z.coerce.number().default(0.01),
MAX_BET_SOL:                z.coerce.number().default(10),
MIN_GIFT_SOL:               z.coerce.number().default(0.01),
MAX_GIFT_SOL:               z.coerce.number().default(10),
GIFT_DAILY_CAP_SOL:         z.coerce.number().default(50),
HOUSE_MINIMUM_RESERVE_SOL:  z.coerce.number().default(5),
PAYOUT_ALERT_THRESHOLD_SOL: z.coerce.number().default(20),
```

The server must crash at boot with a clear message if any required value is missing. No fallbacks for secrets.

---

## 3. Solana service (solana/payoutService.ts)

### 3.1 sendPayout

```ts
sendPayout(toWallet: string, amountSOL: number): Promise<string>  // returns txSig
```

Requirements:
- Load keypair once at module init from `config.HOUSE_WALLET_PRIVATE_KEY` (`Keypair.fromSecretKey(Uint8Array.from(JSON.parse(...)))`).
- **Balance guard before every send:** fetch house balance; if `balance - amount < HOUSE_MINIMUM_RESERVE_SOL`, call `alertService` at `critical` and throw. Never send.
- **Large-payout alert:** if `amount > PAYOUT_ALERT_THRESHOLD_SOL`, alert (but proceed).
- Use `sendAndConfirmTransaction` at `confirmed` commitment.
- Round lamports with `Math.floor(amountSOL * 1e9)` — never fractional lamports.
- On error, throw with a message safe to log (no key material). The caller decides DB consequences.

### 3.2 verifyDeposit

```ts
verifyDeposit(opts: {
  txSignature: string
  expectedSender: string
  expectedAmountSOL: number
  maxAgeSeconds?: number      // default 120
}): Promise<true>             // throws on any failure
```

Requirements, all mandatory:
- `getParsedTransaction` at `confirmed`, `maxSupportedTransactionVersion: 0`.
- Retry up to 10× at 2s intervals for indexing lag; then throw "not found".
- Reject if `tx.meta.err` is set.
- Reject if `blockTime` older than `maxAgeSeconds`.
- Reject if fee payer (accountKeys[0]) ≠ `expectedSender`.
- Compute received = post − pre balance at the house wallet's account index; reject if `< expectedAmountSOL − 0.000005` tolerance.
- House wallet index found by address match against `config.HOUSE_WALLET_ADDRESS`; reject if absent.

### 3.3 getHouseBalance / sweepToCold

- `getHouseBalance(): Promise<number>` — lamports → SOL.
- `sweepToCold(keepFloatSOL: number)` — if `balance − keepFloat > 0.01`, send the excess to `COLD_WALLET_ADDRESS`, insert a `payouts` row with `type='house_sweep'`, alert with the amount. Wire into `jobs/sweep.ts` on a daily schedule. Ask the owner whether they prefer node-cron or a 24h interval before adding a dependency.

---

## 4. Deposit flow

### 4.1 Nonces (services/nonceService.ts)

- `issueNonce(wallet): Promise<string>` — `crypto.randomUUID()`, row in `nonces` with `expiresAt = now + 2 min`.
- `consumeNonce(nonce, wallet): Promise<boolean>` — single atomic `UPDATE ... SET used_at = now() WHERE nonce = ? AND wallet = ? AND used_at IS NULL AND expires_at > now() RETURNING`. True iff a row returned. **No select-then-update.**
- Hourly cleanup of expired rows.

### 4.2 Deposit confirm (services/depositService.ts + routes/deposits.ts)

```
POST /api/deposits/nonce     (auth) → { nonce, depositAddress }
POST /api/deposits/confirm   (auth) ← { matchId, txSig, nonce, amountSol }
```

Confirm sequence — order matters:
1. Zod-validate body (`txSig` 80–200 chars, `nonce` uuid, `amountSol` within MIN/MAX_BET, `matchId` uuid).
2. `consumeNonce(nonce, jwtWallet)` — reject if false.
3. `verifyDeposit({ txSignature, expectedSender: jwtWallet, expectedAmountSOL: amountSol })`.
4. Insert `deposits` row. **`txSig` has a UNIQUE constraint** — a violation means replay; return 409, credit nothing.
5. In the same transaction: insert `matchPlayers` row (`status='deposited'`, `currentPot = amountSol`) and increment `matches.totalPot` via `sql`-level arithmetic.
6. Emit `lobby:playerDeposited` to the match room.

Rate limit: 10/min per wallet on both routes.

---

## 5. Server-side result validation (validation/gameEvents.ts)

Game clients report EVENTS. Every event passes three gates before it reaches the wager engine: **shape, authority, plausibility.**

### 5.1 Shape (Zod)

```ts
KillEvent:  { matchId: uuid, victim: string(44) }          // killer = socket.data.wallet
QuizAnswer: { matchId: uuid, questionIndex: int ≥ 0, answerIndex: 0..3 }
MatchEnd:   { matchId: uuid }                               // NO winner field — see below
Resign:     { matchId: uuid }
```

`MatchEnd` deliberately carries no winner. The server derives the winner from its own recorded state; a client-supplied winner is never accepted, even from a trusted game server process.

### 5.2 Authority

- The acting wallet is `socket.data.wallet`. A kill's killer, an answer's answerer, a resignation's resigner — always from the socket, never the payload.
- Killer and victim must both be `matchPlayers` rows for that `matchId` with `status='active'`.
- `matches.status` must be `'active'`.
- Self-kill (`killer === victim`) rejected.

### 5.3 Plausibility (anti-cheat sanity checks)

Pure functions the socket handlers call before the engine:
- **Kill cadence:** reject a kill if the same killer's previous kill in this match was < `MIN_KILL_INTERVAL_MS` ago (default 1500ms, per-game configurable). Log rejections (wallet, matchId, reason).
- **Quiz timing:** answers accepted only inside the server's question window, timestamped at receipt. Client timestamps ignored. Questions and correct answers are never sent to clients before the window closes (the existing quiz route strips answers — preserve that).
- **Event flood:** per-socket rate limit (60 events/min general, 20/min for kills) — drop and log excess.
- **Turn-based 1v1 games (chess/checkers/connect):** the server validates move legality before applying. Where a validator doesn't exist yet, the handler must REJECT rather than trust — stub it, and report to the owner which games lack validators. Never wire a turn-based game to real money without its validator.

A rejected event is logged and answered with a socket `error`; it never partially applies.

---

## 6. Wager engine (services/wagerEngine.ts)

All money math lives here. Games call these functions; nothing else touches pots.

### 6.1 resolveKill({ config, killer, victim, reason })

- Read the victim's row fresh from DB (must be `active`). `victimPot = Number(row.currentPot)`.
- `steal` (1v1, snake): killer credited `victimPot × (1 − fee)`, house takes `victimPot × fee`. Victim eliminated, pot zeroed.
- `accumulate` (slayer): **no SOL moves on a kill.** Increment the killer's `kills` only; eliminate the victim. Payment happens once, at settlement (§6.3).
- Environment kill (`killer === null`, reason `zone` | `asteroid`): house takes the victim's full pot; victim eliminated.
- All mutations in one `db.transaction`, using `sql`-arithmetic (`current_pot + x`, `kills + 1`). The victim update carries `WHERE status='active'`; if it affects no row (concurrent kill already landed), abort the transaction and reject the event.

### 6.2 settle1v1 / settleSnake({ matchId, winner })

- **Atomic claim:** `UPDATE matches SET status='settling' WHERE id=? AND status='active' RETURNING` — no row ⇒ abort ("already settling").
- Winner's payout = winner's `currentPot × (1 − fee)`, read from DB after the claim.
- `sendPayout`, then in one transaction: `matches → 'settled'` (+ txSig, winner, settledAt), `payouts` row (`type='win'`), player ranks.
- If `sendPayout` throws: leave status `'settling'`, alert, do **not** retry automatically. Orphaned `settling` rows are a manual-review queue — expose via `GET /api/internal/orphaned` (auth-gated).

### 6.3 settleSlayer({ matchId })

Fires when the last player stands. One settlement pass pays everyone:
- Atomic claim as above.
- Per `matchPlayers` row: `earned = kills × entryFee`; `payout = earned × (1 − fee)`.
- **Solvency invariant:** Σ earned ≤ `matches.totalPot` − house's environment-kill takings. Assert before any send; on violation, alert `critical` and leave in `'settling'` for review — this catches engine bugs before they overpay.
- Send payouts **sequentially**, not `Promise.all` — keeps the balance guard meaningful. One `payouts` row each (`type='slayer_kill'`).
- Remainder after payouts + fees → `houseTotal`. Ranks by elimination order; survivor rank 1.

### 6.4 settleQuizFfa({ matchId })

- Winner = most correct answers; tie-break by lowest cumulative server-recorded answer time. Computed exclusively from server-recorded answers.
- Then identical to settleSnake (winner takes pot minus fee).

### 6.5 resign({ matchId, wallet })

- 1v1: transfer the resigner's pot to the opponent's pot (SQL arithmetic), then `settle1v1` with the opponent as winner.
- snake / slayer / quiz_ffa: resigner's pot → `houseTotal`; in slayer the resigner's kills are zeroed (forfeits banked kills, matching the published T&C).

---

## 7. Atomic patterns (mandatory, verbatim)

1. **Claim-before-pay.** Every settlement starts with the `status='settling'` conditional UPDATE. SOL is sent only after a successful claim; finalisation to `'settled'` only after the send returns a txSig.
2. **SQL arithmetic for balances:** `sql\`current_pot + ${amount}\`` — never JS read-add-write.
3. **Row locks** (`.for('update')` in a transaction) for any unavoidable read-modify-write.
4. **Unique constraints as backstops:** `deposits.txSig` UNIQUE (exists). Add UNIQUE `(match_id, wallet)` on `matchPlayers` — one seat per wallet per match.
5. **Guarded victim updates:** elimination updates include `status='active'` in the WHERE; check affected-row count.
6. **No auto-retry of failed sends.** A thrown `sendPayout` leaves the intermediate state for human review — the SOL may or may not have left, and only a human with the explorer can tell.

---

## 8. Gifting system (services/giftService.ts + routes/gifts.ts)

Direct SOL, routed through the house wallet as intermediary so both legs are verified and logged. House fee applies.

```
POST /api/gifts/nonce   (auth) → { nonce, depositAddress }
POST /api/gifts/send    (auth) ← { toWallet, amountSol, txSig, nonce }
```

Flow for `/send`:
1. Zod: `toWallet` length 44 and ≠ sender; `amountSol` within `MIN_GIFT_SOL..MAX_GIFT_SOL`; `txSig`; `nonce` uuid.
2. `consumeNonce(nonce, jwtWallet)`.
3. `verifyDeposit({ txSignature, expectedSender: jwtWallet, expectedAmountSOL: amountSol })`.
4. Insert `deposits` row (`matchId` null — reuses the UNIQUE txSig backstop). A 409 is a replay; stop.
5. `payout = amountSol × (1 − fee)`; `sendPayout(toWallet, payout)`.
6. One transaction: `gifts` row (from, to, amountSol, outbound txSig, `status='completed'`), `payouts` row (`type='gift'`).
7. Notification to recipient (`type='gift'`), socket push if online.

Edge rules:
- The recipient does not need an existing account — upsert `users` on the fly. Gifts to brand-new players are allowed by design.
- Rate limit: 5 gifts/min per wallet. **Daily cap:** Σ of sender's `gifts.amountSol` today must not exceed `GIFT_DAILY_CAP_SOL`; reject over cap. This is the money-laundering brake — do not remove or raise it without the owner's explicit instruction.
- If `sendPayout` fails after the deposit verified: write the `gifts` row with `status='failed_payout'` (add a `status` column to the gifts table), alert `critical`, surface in the orphaned queue. The sender's SOL is sitting in the house wallet; a human resolves (retry or refund) — never auto-retry.

---

## 9. Alerts (services/alertService.ts)

```ts
alert(level: 'info' | 'warn' | 'critical', subject: string, data: object)
```

- Always emit structured JSON to stderr (Railway logs are the baseline channel).
- `critical` additionally attempts email if `ALERT_EMAIL` + a provider key are configured; stub the provider behind one function so Resend can be wired later without touching call sites.
- Mandatory alert points: balance below reserve · payout above threshold · solvency invariant violation · orphaned settlement created · gift payout failure · ≥5 plausibility rejections from one wallet within 10 minutes.

---

## 10. Acceptance criteria (all on devnet)

Write `scripts/devnet-smoke.ts` the owner can run end-to-end. It must demonstrate:

- [ ] Deposit: nonce → real devnet transfer → confirm credits exactly once; replaying the same txSig returns 409 and credits nothing.
- [ ] Expired and reused nonces rejected.
- [ ] Wrong-sender and wrong-amount deposits rejected by `verifyDeposit`.
- [ ] 1v1 full flow: two deposits → kill event → settle → winner receives pot−fee on-chain; `payouts` row matches the txSig.
- [ ] Double-settle race: two concurrent settle calls → exactly one payout (assert via `payouts` count).
- [ ] Concurrent kills of one victim → exactly one applies.
- [ ] Slayer: 4 players, assorted kills incl. one environment kill → each paid `kills × entryFee × (1 − fee)`; remainder to house; solvency invariant holds.
- [ ] Quiz: answers only accepted in-window; winner derived server-side; settlement pays correctly.
- [ ] Gift: two-leg flow completes; daily cap enforced; self-gift rejected; gift to a wallet with no account succeeds.
- [ ] Balance guard: with the reserve artificially raised, payout refuses and alerts.
- [ ] Orphaned queue: kill the process between claim and finalise → row appears at `/api/internal/orphaned`.
- [ ] `bun run typecheck` passes; existing tests pass.

## 11. Working style

- Comment generously — the owner reads the code to learn from it.
- Small files, one job each. Conventional over clever.
- One commit per section of this doc, message referencing it (e.g. `feat(wager): §6.3 slayer settlement`).
- Ambiguity about money: stop and ask the owner. Ambiguity about naming or structure: decide and note the decision.
