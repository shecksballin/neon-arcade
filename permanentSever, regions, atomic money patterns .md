# Permanent Server Architecture — Neon Cells / Neon Asteroids (Free Play)

> **Scope:** How the always-on, agar.io/slither.io-style Free Play servers work — the game loop, scaling, multi-region deployment, and the database patterns that keep money safe when several regions write to one database at once.
>
> **Companion doc:** `BACKEND_HANDOFF.md` (stack, security protocol, wager engine). This doc assumes that one. Where they conflict, the handoff doc wins on stack choices; this doc wins on permanent-server specifics.

---

## 1. What makes Free Play different

Every other mode in the platform is a **match**: it starts, it ends, it settles. Free Play has none of that.

| | Lobby modes (snake / slayer / 1v1) | Free Play (permanent) |
|---|---|---|
| Lifecycle | start → play → settle → end | never ends |
| Players | fixed set, all join at once | join and leave continuously |
| Payout trigger | match end | player cash-out or death |
| Server loop | runs for the match duration | runs forever |
| Region | irrelevant | core concept — separate worlds |

Consequences that follow from "never ends":

- There is no final settlement pass. Every payout is per-player, on cash-out.
- Death is not elimination — it is a pot loss plus respawn at entry fee.
- The world must stay populated and balanced without a matchmaking queue.
- The server process is long-lived, so memory leaks and unbounded state actually matter.

---

## 2. The tick loop

One authoritative loop per server instance. It never stops while the process is alive.

```ts
const TICK_RATE = 20                 // 20 Hz — slither.io territory
const TICK_MS = 1000 / TICK_RATE

setInterval(() => {
  // 1. Apply queued player inputs (direction only — never position)
  for (const [id, player] of players) {
    applyInput(player, inputQueue.get(id))
    inputQueue.delete(id)
  }

  // 2. Step the world: movement, orb pickups, collisions, kills
  stepWorld(world)

  // 3. Broadcast — per player, only what they can see (see §3)
  for (const [id, player] of players) {
    io.to(id).emit('world:state', getVisibleState(world, player))
  }
}, TICK_MS)
```

### Rules that are not optional

**Clients send input, never position.** A client that reports its own coordinates can teleport onto kills and steal pots. The server owns all positions.

```ts
// client → server
socket.emit('arena:input', { dx, dy })      // ✅ direction
socket.emit('arena:input', { x: 900, y: 40 }) // ❌ never accept this
```

**Validate input shape every tick.** Zod on the socket payload, same as every other event:

```ts
const InputSchema = z.object({
  dx: z.number().min(-1).max(1),
  dy: z.number().min(-1).max(1),
})
```

**Clamp speed server-side.** Even with direction-only input, normalise the vector so a client sending `{dx: 1000, dy: 1000}` doesn't move faster than everyone else.

**Client-side interpolation is required.** At 20 Hz, raw positions look choppy. The client renders at 60fps by interpolating between the last two received states. Without it the game feels broken even though the server is correct.

---

## 3. Interest management (the scaling primitive)

Never broadcast the whole world to everyone. With `n` players that is O(n²) traffic and it collapses somewhere around 50–80 players.

```ts
const VIEW_RADIUS = 1500

function getVisibleState(world, player) {
  return {
    players: world.spatialGrid.queryPlayers(player.x, player.y, VIEW_RADIUS),
    orbs:    world.spatialGrid.queryOrbs(player.x, player.y, VIEW_RADIUS),
    // pot values of visible players are included — that is the whole
    // tension of the mode (you can see who is worth killing)
  }
}
```

### Spatial grid

Bucket the world into fixed cells. Only check the player's cell and its 8 neighbours.

- Turns collision checks from O(n²) into roughly O(n).
- Cell size ≈ 2× the largest entity diameter is a reasonable starting point.
- Rebuild or update the grid once per tick, before collision resolution.

This is the single most important optimisation in an agar-style game. Build it before anything else in the loop.

---

## 4. Player lifecycle

```
join → deposit verified → spawn → play ⇄ die/respawn → cash out → despawn
```

### Join
1. Player deposits entry fee (nonce + on-chain verification per the handoff doc).
2. Server creates a `matchPlayers` row with `status='active'`, `currentPot = entryFee`.
3. Player spawns into the world.

### Death by another player
- Killer takes the victim's entire pot (minus house fee).
- Victim's `currentPot` resets to `entryFee` and they respawn — `status` stays `'active'`.
- Victim's kill count and auto-cash-out preference persist across the respawn.
- ELO updates incrementally, per kill (K=12), no match end needed.

### Death by environment (zone / asteroid)
- House takes the victim's full pot, no fee split.
- **No respawn** — the player is removed from the server (`status='eliminated'`).

### Cash out
- Manual: hold the button for 3 seconds (holding hinders movement — that is the intended risk).
- Preset: a SOL threshold chosen in the lobby before loading in; a 5-second poller cashes them out when `currentPot` reaches it.
- Either path pays out, sets `status='cashed_out'`, zeroes `currentPot`, and despawns them.

### Disconnect
Decide one policy and apply it consistently:
- **Grace window** (recommended): hold the player's state for ~60s. Reconnect resumes; timeout auto-cashes-out at current pot.
- The player's body should remain killable during the grace window, or disconnecting becomes a way to protect a large pot.

---

## 5. Regions

**Regions are separate server instances, not a column on a shared world.** Each region is its own world with its own players, its own tick loop, its own in-memory state. A player in EU cannot see or kill a player in Asia.

```
Railway service (us-east)  →  world loop  ─┐
Railway service (eu-west)  →  world loop  ─┼→  shared Neon (wallets, pots, ELO, payouts)
Railway service (ap-south) →  world loop  ─┘
```

### Deployment
- One Railway service per region, all from the same repo.
- Each gets `REGION` as an env var and Railway's own region set to match.
- Same image, different placement. No code forks.

```ts
const REGION = process.env.REGION  // 'us-east' | 'eu-west' | 'ap-south'
```

### Region selection in the client
Ping each region's health endpoint and show latency, slither.io style:

```ts
const start = performance.now()
await fetch(`${region.url}/ping`)
const latency = performance.now() - start
```

Show the number, default to the lowest, let the player override.

### Sharding within a region
When one region outgrows a single instance:
- Cap each world at ~150–200 concurrent players.
- Spin up additional instances in the same region; assign joiners to whichever has room.
- Redis + the Socket.io adapter lets instances share cross-cutting features (chat, presence, friend invites) while each keeps its own independent world loop.

---

## 6. Atomic money patterns

**This is the section that matters most.** Regions are isolated worlds but they share one Neon database. Every money mutation must be safe against concurrent writes from multiple server instances.

### Principle: the database is the only source of truth for money

In-memory pot values in a world loop are a *cache for rendering*. Never settle, cash out, or pay from memory — always read from Neon at the moment of the money operation.

### Pattern 1 — Atomic claim before payout

Never "read then write". Claim the row atomically and act only if the claim succeeded.

```ts
// Claim: only one caller can win this, even across regions
const [claimed] = await db
  .update(matchPlayers)
  .set({ status: 'cashing_out' })          // intermediate state
  .where(and(
    eq(matchPlayers.matchId, matchId),
    eq(matchPlayers.wallet, wallet),
    eq(matchPlayers.status, 'active')       // ← the guard
  ))
  .returning()

if (!claimed) throw new Error('Already cashing out or not active')

// Only now send SOL
const txSig = await sendPayout(wallet, payout)

// Finalise
await db.update(matchPlayers)
  .set({ status: 'cashed_out', currentPot: '0' })
  .where(eq(matchPlayers.id, claimed.id))
```

The intermediate `cashing_out` / `settling` state is what makes a crash mid-payout detectable rather than silently double-paying on retry.

### Pattern 2 — Row locks for read-modify-write

When you must read a value and write based on it, lock the row:

```ts
await db.transaction(async (tx) => {
  const [player] = await tx
    .select()
    .from(matchPlayers)
    .where(eq(matchPlayers.id, playerId))
    .for('update')                          // ← row-level lock

  // no other transaction can touch this row until we commit
  await tx.update(matchPlayers)
    .set({ currentPot: String(Number(player.currentPot) + amount) })
    .where(eq(matchPlayers.id, playerId))
})
```

### Pattern 3 — SQL-level arithmetic instead of read-then-write

Better than a lock where possible, because it is a single atomic statement:

```ts
// ✅ atomic — Postgres computes it, no race window
await tx.update(matchPlayers)
  .set({ currentPot: sql`current_pot + ${killerGets}` })
  .where(eq(matchPlayers.wallet, killer))

// ❌ racy — two kills landing together can lose one
const pot = Number(player.currentPot)
await tx.update(matchPlayers).set({ currentPot: String(pot + killerGets) })
```

Use this for every pot credit in the kill path. Kills in a busy world land close together; this is a real race, not a theoretical one.

### Pattern 4 — Unique constraints as a last line of defence

```ts
txSig: text('tx_sig').notNull().unique()
```

A duplicate deposit credit becomes a database error rather than free money. Constraints catch bugs that application logic misses.

### Pattern 5 — One active session per wallet (cross-region)

Because regions are separate processes, nothing in application code stops a wallet joining us-east and eu-west simultaneously and double-spending a deposit. Enforce it in the database:

```sql
-- Partial unique index: a wallet can hold at most one active row
CREATE UNIQUE INDEX one_active_session_per_wallet
  ON match_players (wallet)
  WHERE status = 'active';
```

The second join attempt fails at the database, in whichever region it arrives. This must exist before Free Play ships.

### Pattern 6 — Kill resolution is one transaction

A kill mutates two players and the house total. All of it commits or none of it does:

```ts
await db.transaction(async (tx) => {
  // victim: pot to zero, reset to entry fee (respawn)
  await tx.update(matchPlayers)
    .set({ currentPot: String(config.entryFee), eliminatedBy: killer })
    .where(and(
      eq(matchPlayers.matchId, matchId),
      eq(matchPlayers.wallet, victim),
      eq(matchPlayers.status, 'active')     // guard: not already dead
    ))

  // killer: credit + kill count, atomically
  await tx.update(matchPlayers)
    .set({
      currentPot: sql`current_pot + ${killerGets}`,
      kills:      sql`kills + 1`,
    })
    .where(eq(matchPlayers.wallet, killer))

  // house cut
  await tx.update(matches)
    .set({ houseTotal: sql`house_total + ${houseTakes}` })
    .where(eq(matches.id, matchId))
})
```

Note the `status='active'` guard on the victim update — it prevents two killers being credited for the same victim in the same tick.

### Pattern 7 — Idempotent payouts

Every payout writes a `payouts` row. Before sending SOL, the claim (Pattern 1) must have succeeded. On restart after a crash, orphaned `cashing_out` / `settling` rows are surfaced for manual review — **never auto-retried**, because the SOL may already have been sent.

### Pattern 8 — House balance guard

Before every payout:

```ts
const balance = await getHouseBalance()
if (balance - payout < MINIMUM_RESERVE) {
  await alertAdmin('House wallet low', { balance, payout })
  throw new Error('Insufficient house balance')
}
```

With multiple regions paying out concurrently, the float drains faster than a single-region estimate suggests. Size the reserve accordingly.

---

## 7. Long-lived process concerns

The Free Play process runs for weeks. Things that are harmless in a match server become leaks here.

- **Clean up on despawn.** Remove the player from `players`, the input queue, the spatial grid, and any per-player timers. A forgotten `Map` entry per disconnect is a slow memory leak.
- **Cap unbounded collections.** Orb counts, kill feeds, chat scrollback — all need ceilings.
- **Reset per-tick scratch state.** Do not accumulate arrays across ticks.
- **Expect restarts.** Deploys, crashes, and Railway restarts will happen with players mid-session. On shutdown, auto-cash-out every active player rather than losing their pots — treat graceful shutdown as a first-class code path, not an afterthought.
- **Health endpoint.** `/ping` for latency measurement and for Railway's health checks.

---

## 8. Build order

1. Spatial grid + world state model (no networking yet — testable in isolation)
2. Tick loop with server-authoritative movement
3. Interest management / per-player visible state
4. Socket join/leave lifecycle + input handling with Zod validation
5. Client interpolation (game feels wrong without it — do not defer)
6. Kill resolution wired to the wager engine (Patterns 3 + 6)
7. Cash-out: manual hold + preset threshold poller (Pattern 1)
8. Death/respawn + environment kills
9. Per-kill ELO
10. Graceful shutdown with auto-cash-out
11. Second region + latency-based picker
12. Partial unique index (Pattern 5) — **before any real money**

Devnet throughout. Cap entry fees low at launch.
