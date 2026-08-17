import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

/**
 * Which vendor chunk a node_modules file belongs in.
 *
 * WHY SPLIT AT ALL — everything used to land in ONE 2.79 MB entry chunk, so a
 * returning visitor re-downloaded the entire wallet stack because a single
 * line of app code changed. Splitting by dependency means the app's own hash
 * churns on every deploy while react/motion/privy stay cached, and the pieces
 * download in parallel instead of as one serial blob.
 *
 * Note the `.split('node_modules/').pop()` — under Bun's store, paths look
 * like `node_modules/.bun/pkg@1.2.3/node_modules/pkg/…`, so naively taking
 * the segment after the FIRST `node_modules/` labels every package `.bun`
 * and silently produces one chunk again.
 */
function vendorChunk(id: string): string | undefined {
  // Vite's __vitePreload helper. It is a handful of lines shared by every
  // dynamic import in the app, and if Rollup is left to place it, it lands in
  // whichever lazy chunk it likes — which then becomes a STATIC dependency of
  // the entry. That is exactly what happened: the entry chunk imported a
  // single symbol from the 3.6 MB wallet chunk, so the browser dutifully
  // modulepreloaded the whole wallet stack on the landing page and the
  // deferral bought nothing. Pinning the helper to the always-loaded react
  // chunk keeps the lazy chunks genuinely lazy.
  if (id.includes('vite/preload-helper')) return 'react';

  if (!id.includes('node_modules')) return;
  const tail = id.split('node_modules/').pop()!;
  const seg = tail.split('/');
  const pkg = seg[0].startsWith('@') ? `${seg[0]}/${seg[1]}` : seg[0];

  // React must be ONE chunk with everything that shares its internals, or two
  // copies of the renderer end up loaded.
  if (/^(react|react-dom|scheduler|use-sync-external-store)$/.test(pkg)) return 'react';

  // The wallet stack. Reached only through the lazy import in src/auth, so
  // naming it keeps that boundary visible in the build output — if this chunk
  // ever shows up as an entry dependency, the deferral has regressed.
  if (
    pkg.startsWith('@privy-io/') ||
    pkg.startsWith('@walletconnect/') ||
    pkg.startsWith('@reown/') ||
    pkg.startsWith('@coinbase/') ||
    pkg.startsWith('@base-org/') ||
    pkg.startsWith('@base-ui/') ||
    /^(viem|ox|abitype|libphonenumber-js|secure-password-utilities|@headlessui\/react)$/.test(pkg)
  ) {
    return 'wallet';
  }

  // Solana is SEPARATE from the wallet SDK on purpose. The RPC client and
  // bs58 are reached by ordinary features (the balance readout, the sign-in
  // signature) as well as by Privy, so grouping them together meant one
  // import of `bs58` from a hook made the browser modulepreload the entire
  // 3.7 MB wallet chunk before first paint. Kept apart, a stray Solana
  // import costs a Solana-sized chunk and nothing more.
  if (pkg.startsWith('@solana/') || pkg.startsWith('@solana-program/') || pkg === 'bs58') {
    return 'solana';
  }

  // three.js and friends, already behind React.lazy at every use site.
  if (/^(three|postprocessing|maath)$/.test(pkg) || pkg.startsWith('@react-three/')) return 'three';

  // ogl is a SEPARATE, much smaller WebGL library — it only powers the
  // Ferrofluid blob behind the library grid and the lobbies. Grouping it with
  // three.js (an easy mistake: both say "WebGL") meant opening the library
  // downloaded 268 kB gzip of three.js that nothing on that screen uses.
  if (pkg === 'ogl') return 'ogl';

  if (pkg.startsWith('motion') || pkg === 'framer-motion') return 'motion';
  if (pkg === 'gsap') return 'gsap';
  if (pkg === 'chess.js' || pkg === 'stockfish') return 'chess';

  // NO CATCH-ALL. Returning a 'vendor' bucket here merged deps the landing
  // page needs (react-query, socket.io) with deps only one game needs
  // (@phosphor-icons' 160 kB web components, used solely by the chess combat
  // overlay) — and because the entry touched the bucket, the browser
  // preloaded all of it. Undefined hands the decision back to Rollup, which
  // places each module by who actually reaches it.
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
    dedupe: ['react', 'react-dom', 'three', '@react-three/fiber', '@react-three/drei'],
  },
  build: {
    // Baseline for browsers that support dynamic import + import.meta, which
    // the code-splitting throughout the app already requires.
    target: 'es2020',
    // The wallet chunk is legitimately large and lazily loaded; the default
    // 500 kB warning just adds noise to every build.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
  /**
   * TUNNELLED HOSTS
   * ---------------
   * Vite refuses any request whose `Host` header it does not recognise and
   * answers "Blocked request. This host is not allowed." — protection
   * against DNS rebinding, and the reason a Cloudflare tunnel pointed at
   * this server returns that string instead of the app.
   *
   * `.trycloudflare.com` covers the throwaway URLs `cloudflared tunnel
   * --url` hands out (they are random per run, so they cannot be listed
   * individually). The leading dot means subdomains only — it does NOT
   * allow the bare domain, and nothing else is opened up. Add your own
   * hostname here too if you move to a named tunnel.
   *
   * Both blocks matter: `server` is `bun run dev`, `preview` is the built
   * bundle — and preview is what you want behind a tunnel, since a dev
   * server ships hundreds of unbundled modules over it.
   */
  server: {
    hmr: process.env.DISABLE_HMR !== 'true',
    allowedHosts: ['.trycloudflare.com'],
  },
  preview: {
    allowedHosts: ['.trycloudflare.com'],
  },
});
