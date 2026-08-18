# Perf brief — Neon Arcade preview (`bhvr-migration`)

**For:** a coding agent with write access to this repo.
**From:** browser-side measurement of the deployed preview on 2026-08-17. No repo access, no sourcemaps (all `/assets/*.js.map` → 404), so every claim below is observed from the network + console + runtime of the built app. Filenames are build output hashes; you'll need to map them back to source.

Read the "Do not" list at the bottom before starting.

---

## TL;DR

The server is fine. TTFB was 214ms and the HTML document is 1.7KB. The problem is **1.72MB gzipped / 5.8MB parsed of JavaScript loaded eagerly on the landing page**, two-thirds of which is a wallet SDK the landing page never uses. A preview-only Vercel toolbar adds ~1.6s on top, which is why previews feel worse than prod.

Priority order: (1) defer the wallet chunk, (2) guard Privy init when the app id is missing, (3) defer `three`, (4) fix the WebGL cursor, (5) chase the stray fetch at 5.1s.

---

## Measurements

### Document / timing

| Metric | Value |
|---|---|
| TTFB | 214 ms |
| Response end | 343 ms |
| HTML transferred | 1,679 B (2,938 B decoded) |
| DOM interactive | 790 ms |
| DOMContentLoaded | 801 ms |
| First contentful paint | 944 ms |
| Load event | 3,070 ms |
| Resource count | 39 |

### Own JS chunks — the actual problem

Total own-origin assets: **1,801,867 B encoded / 6,082,380 B decoded.** Third-party total is only 29,538 B decoded, so this is entirely first-party weight.

| Chunk | Gzipped | Parsed | Fetch start | Eager? |
|---|---:|---:|---:|---|
| `wallet-BVAn_Eak.js` | **1,252,303 B** | 4,224,669 B | 817 ms | **yes** |
| `three-CfQAzNRZ.js` | 262,869 B | 955,835 B | 817 ms | **yes** |
| `index-IFbJrV9S.js` | 75,933 B | 252,572 B | 466 ms | yes (entry) |
| `react-CZZ-cJ32.js` | 63,872 B | 199,744 B | 466 ms | yes (expected) |
| `motion-XAVWAJTq.js` | 43,853 B | 126,582 B | 466 ms | **yes** |
| `solana-DZPfxpUr.js` | 29,130 B | 120,476 B | 813 ms | **yes** |
| `gsap-CzGW6FVa.js` | 29,121 B | 70,462 B | 3,221 ms | no — already deferred |
| `ogl-DfWMHKQ0.js` | 13,353 B | 44,369 B | 3,221 ms | no — already deferred |
| `SidebarMenu-DG2K-e34.js` | 10,222 B | 34,763 B | 813 ms | yes |

`gsap` and `ogl` already load late, so whatever pattern is used for those is the pattern to copy for the rest.

### Runtime

- ~41 fps while idle, one full-viewport `<canvas>` at 1534×894, `devicePixelRatio` 1
- 0 long tasks recorded, JS heap ~106 MB
- The framerate cost is continuous per-frame WebGL work, not a single blocking task

### Console errors (all reproducible on load)

1. `[Privy] VITE_PRIVY_APP_ID is missing or malformed — wallet login is disabled.` — logged **3×** from `privyRuntime-BX_9ISqS.js`
2. `PrivyApiError: Invalid Privy app ID` from `wallet-*.js` — despite the guard above, a network request still fires to `auth.privy.io/api/v1/apps/privy-app-id-not-set-xxxx`, **445 ms, fails**, starting at 4,933 ms
3. `TypeError: Cannot read properties of null (reading 'internalFormat')` in `SplashCursor-B3nwIpbM.js`, caught by `SafeErrorBoundary`, preceded by ~20 `console.trace` calls with null arguments left in that file

### Third-party

- `vercel.live/_next-live/feedback/feedback.html` — iframe, **1,605 ms**, starts at 1,465 ms
- `vercel.live/_next-live/feedback/feedback.js` — 435 ms
- `vercel.live/geist.woff2` — 119 ms

This is the Vercel preview comment toolbar. **It does not exist on production deployments.** Any before/after comparison must be run against prod or a local `vite preview`, or this noise will swamp the signal.

### Unexplained — worth a look

A `fetch` to the site root `/` fires at **5,113 ms** and takes 267 ms, returning ~300 B. A runtime fetch to `/` that late smells like an API call with an unset base URL falling through to the SPA's `index.html` fallback. Check whether something like `VITE_API_URL` is unset in the preview env and the client is doing `fetch(import.meta.env.VITE_API_URL + '/something')` with `undefined` collapsing to a relative path. If so it's silently returning HTML where JSON is expected.

---

## Work items

### 1. Defer the wallet/Privy chunk — biggest win by far

1.19 MB gzipped, 4.03 MB parsed, fetched at 817 ms, and the landing page renders nothing that needs it until someone clicks **Connect**.

Find where the Privy provider is mounted — likely a `PrivyProvider` wrapping the app in `apps/web/src/main.tsx`, `App.tsx`, or a `providers/` module — and make it load on demand instead of at module scope.

Two workable shapes; pick whichever fits the existing structure:

- **Lazy provider:** `const WalletProvider = lazy(() => import('./providers/WalletProvider'))`, rendered inside `<Suspense>` only once wallet UI is needed. Requires that nothing above it calls `usePrivy()` during initial render.
- **Trigger-on-intent:** keep a lightweight context that exposes `connect()`; the first call does `await import('./providers/WalletProvider')` and mounts it. Prefetch on `pointerenter` of the Connect button so the click feels instant.

The second is usually less invasive in an app where hooks are scattered.

`solana-DZPfxpUr.js` (29 KB gz) should follow the wallet chunk — check whether it's imported independently or only via wallet code.

**Watch out:** if `vite.config.*` has a `manualChunks` map (the chunk names strongly suggest it does), verify your dynamic import isn't defeated by a `manualChunks` group that merges wallet code back into an eagerly-imported vendor chunk. Splitting the static import graph is what matters; `manualChunks` only decides how the resulting modules are grouped into files.

**Acceptance:** on a cold load of `/`, `wallet-*.js` and `solana-*.js` do not appear in the network waterfall. They appear only after interacting with Connect.

### 2. Guard Privy init when the app id is absent

There's already a guard emitting the "missing or malformed" message, but it isn't preventing the SDK from initializing — the failed `auth.privy.io` request proves init proceeded anyway. Make the guard actually short-circuit: if the app id is missing or not 25 characters, don't construct the Privy client at all, render whatever disabled-state UI is appropriate, and log **once** rather than three times.

Separately, set `VITE_PRIVY_APP_ID` in Vercel's **Preview** environment so previews exercise a realistic path. That's a dashboard change for the repo owner, not a code change — flag it rather than doing it.

**Acceptance:** no request to `auth.privy.io` on load when the app id is unset; exactly one console warning.

### 3. Defer `three`

257 KB gz / 934 KB parsed, eager at 817 ms. Move it behind whichever route or component actually renders 3D, using the same dynamic-import pattern that already works for `gsap` and `ogl`.

**Acceptance:** `three-*.js` absent from the landing-page waterfall.

### 4. Fix or gate `SplashCursor`

It currently pays full WebGL setup cost and then throws `internalFormat` null — so it's burning startup time to produce an exception. Either:

- fix the format probe (the null read is almost certainly an unsupported float/half-float texture format on this GPU path, where the fallback branch isn't handling a null return from `getExtension`), or
- drop it.

Either way, gate it: skip entirely when `matchMedia('(prefers-reduced-motion: reduce)')` matches, and on coarse-pointer devices where a cursor effect is meaningless. Also remove the ~20 leftover `console.trace()` calls in that file.

**Acceptance:** no console errors from `SplashCursor`, idle framerate at or near 60 on the landing page.

### 5. Verification

Do not trust the preview URL for before/after numbers — the Vercel toolbar adds ~1.6s that has nothing to do with your changes.

```bash
# from apps/web
bun run build
ls -la dist/assets/*.js | sort -k5 -n -r | head -20
# gzipped sizes, which is what actually ships
for f in dist/assets/*.js; do printf '%s %s\n' "$(gzip -c "$f" | wc -c)" "$f"; done | sort -rn | head -20
bun run preview   # then measure a cold load here, not on vercel.app
```

Report the before/after **gzipped total of chunks fetched on a cold landing-page load**. That single number is the deliverable. Baseline to beat: **1,801,867 B**. A realistic target after items 1 and 3 is roughly 250–300 KB gz.

---

## Do not

- **Do not** touch `.env` files or commit any secret. Item 2 mentions a dashboard setting; flag it, don't try to set it.
- **Do not** "optimize" by removing the `SafeErrorBoundary` — it's doing its job.
- **Do not** upgrade or swap out React, Vite, Privy, or `three` versions. This is a code-splitting task, not a dependency task.
- **Do not** add a bundle-analyzer dependency to `package.json` permanently; if you want one, run it via `bunx`/`npx` and leave the manifest clean.
- **Do not** claim an improvement without the gzipped cold-load number from a local `preview` build. The preview URL's numbers are contaminated.
- **Do not** chase FCP. It's already 944ms and it isn't the complaint. The complaint is the 3.07s load and the 41fps.
