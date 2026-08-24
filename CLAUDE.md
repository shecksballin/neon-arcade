# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Neon Arcade — a skill-based gaming site: Vite/React 19 frontend of ~10 neon-styled games, a Bun/Hono/Socket.IO backend with ranked matchmaking, XP progression, and Privy wallet auth. (`README.md` is stale AI-Studio boilerplate — ignore its npm/GEMINI instructions.)

## Commands

```bash
bun install                      # Bun workspaces monorepo (bun@1.3.14)
bun run dev                      # doppler run -- turbo dev  (secrets come from Doppler, NOT .env files)
bun run lint                     # turbo lint = tsc --noEmit in every package — THE check; there is no test suite
cd apps/web && bunx vite build   # production build (also catches chunk-graph regressions)
cd apps/server && bun run db:push     # drizzle-kit push — FAILS in non-TTY; from automation use
                                      # `bunx drizzle-kit generate` then apply the SQL yourself
```

Local server boots on `PORT` (default 3002; web dev expects it there). Booting a second copy for a smoke test: `cd apps/server && PORT=3999 doppler run --preserve-env -- bun run src/index.ts`.

## Deploys (why pushes have side effects)

- Branch `bhvr-migration` auto-deploys BOTH halves on push: Railway runs `apps/server` (watch path `/apps/server/**`), Vercel builds `apps/web` (root dir `apps/web`). Merging to `main` is the production trigger for Vercel.
- Vite inlines `VITE_*` at build time — changing a Vercel env var does nothing until the next build. `VITE_API_URL` must include `https://` (a schemeless host becomes a relative fetch path).
- Server CORS: exact origins from `CLIENT_ORIGIN` + loopback + a `neon-arcade-*-shecksballins-projects.vercel.app` preview regex, all through ONE predicate in `apps/server/src/index.ts` shared by HTTP and the socket engine. Never `*`.
- Test logins only on the branch alias URL — random per-deployment Vercel subdomains are not in Privy's allowed-domains list and OAuth dies there with "Origin not allowed".

## Architecture

Three workspaces: `apps/web`, `apps/server`, `packages/types` (`@neon/types` — the shared vocabulary: XP curve `xp.ts`, rank ladder `elo.ts`, sign-in message builder. Level and rank are ALWAYS derived from raw xp/rp via `getLevelInfo`/`getRankInfo`; never trust a stored level).

### Auth (client `apps/web/src/auth/` + `hooks/useBackendAuth.ts`, server `routes/auth.ts` + `lib/privyIdentity.ts`)

Privy (email/Google → embedded Solana wallet; wallet login is disabled in the dashboard AND must stay out of `loginMethods` — Privy rejects a config requesting a dashboard-disabled method, killing the whole modal). Backend sign-in is **token-first**: the Privy access+identity tokens are verified against Privy's JWKS and the identity token's `linked_accounts` vouches for the wallet — no popup; the nonce+ed25519-signature exchange is only the fallback (client falls back solely on `401 code:'signature_required'` or a 400 from an older server). Sessions are 30-day JWTs, refreshed on load. One person = one account via `account_identities` (canonical-wallet rule in `services/accountService.ts`); PIN+TOTP login is the recovery path that re-adopts a new Privy identity. The Privy provider is a lazy-loaded SIBLING of the app (`auth/index.tsx` explains why) — keep wallet-SDK imports out of the entry graph.

### Server (`apps/server/src`)

Hono HTTP + Socket.IO on `@socket.io/bun-engine` sharing one port (`index.ts` — the `idleTimeout` from `engine.handler()` is load-bearing). Socket contract rules, enforced by convention everywhere:
- Identity is always `socket.data.wallet/username` from the JWT handshake; **wallets never reach another client** — usernames are the only public identifier.
- Every inbound payload is zod-parsed; malformed ones are silently ignored.
- Per-module `socket.on('disconnect')` cleanup — there is deliberately NO central disconnect loop.
- Each game settles rank+stats exactly once via an `eloSettled` flag (or teardown-before-await), through `settleRanked1v1/settleRankedFfa` (TrueSkill hidden skill + visible RP, `rankingLogic.md`) and stats/XP via `games/progression.ts::recordAndEmitProgression`, which also emits per-socket `match:progression` (own XpAward + own PublicRating) — the wire source of the client's post-game XP/rank overlays.
- Mid-match leave/disconnect = forfeit: opponent wins, same settle funnel, end event carries `reason: 'forfeit'`.
- Matchmaking is the shared skill queue in `socket/queue.ts` (`joinQueue` is never silent — always answers `queue:status`). Private wagers (`games/privateMatch.ts`) re-drive each member's normal find event, so game modules need no special handling — but keep its CATALOG, the client `social/privateWagerCatalog.ts`, and each game's events in sync.
- `POST /api/stats/session` is the ONE client-stated result path (iframe games all modes; practice-only for the simulated games) — XP-metered under a rolling daily cap, kills/placement zeroed for practice games, and practice rows are excluded from win-rate SQL. Never let a client-claimed result touch RP.

### Web games (`apps/web/src`)

`lib/games.ts` is the game catalog (library grid, filters, mobile allow-list, titles) — adding/removing a game touches it, `glass/gameIcons.tsx`, the `View` union + lazy mount in `App.tsx`, and usually the private-wager catalogs. Three game shapes:
- **Socket games** (Chess, Connect, Volley, Kickoff): named socket handlers on the ONE shared authed socket singleton (`hooks/useGameSocket.ts`) — always `socket.off` the same named handler; a blanket `off` strips other games' listeners.
- **Iframe games** (Golf, Clumsy, Pug Shooter): vanilla games served from `public/`, results via postMessage → `lib/sessionXp.ts`. Source lives under `src/components/<Game>/` AND a copy in `public/` — edits must be synced to both (recurring footgun). Wrappers navigate the iframe to `about:blank` in unmount cleanup so the GPU context dies deterministically.
- **Native R3F** (Neon Kickoff, `components/neonKickoff/`): zustand store drives a practice AI and an online mode where the server (`socket/games/kickoff.ts`) resolves every kick; the client replays server payloads and applies score arrays only when the ball lands (never at receipt — HUD spoilers). `raw-assets/` is gitignored merge-tool input; runtime GLBs live in `public/neon-kickoff/`.

Shared per-game UX every game is expected to wire: `common/GamePauseMenu` (pug-style Menu pill = the only in-game exit; back chevrons exist only on lobby/library screens), `common/exitGuard` (`useGuardedExit` + all exits through `navigateWithExitGuard` — confirm → forfeit → results → progression → navigate), `common/fullscreen` (ONE global `f` keybind mounted in App — never add per-screen key listeners), `common/LobbyLevelStrip`, `common/PostGameProgression` fed by `useMatchProgression` (online) or `usePracticeXp` (practice; clear + re-arm on every rematch path or the last round's overlay replays).

### Web performance invariants (hard-won; don't regress)

`vite.config.ts::vendorChunk` buckets are deliberate: shared leaves used by two buckets (zustand) get their own chunk or Rollup welds the buckets together (this once made the landing page download the 1.26 MB wallet SDK); `@dimforge/*` (rapier WASM, 2.2 MB) stays isolated so only Kickoff pays for it. The wallet chunk loads on intent/prior-session only. `SplashCursor` idles after 4s and must keep releasing its WebGL context — browsers cap ~16 live contexts and force-lose the oldest.

## Environment / secrets

Doppler is the source of truth (`.env.example` files document names only). Server env is zod-validated in `config/env.ts` — most vars optional at boot with routes answering 503 until set. New env vars must also be added to `turbo.json` `globalPassThroughEnv` (note: that list does NOT affect turbo's cache key — a cached build can survive an env change).
