/**
 * DEFERRED AUTH — Privy off the critical path
 * ===========================================
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * A `<PrivyProvider>` used to wrap the app in main.tsx (from the since-deleted
 * providers/AppPrivyProvider.tsx, whose config now lives in
 * ./privyRuntime.tsx unchanged), which meant the
 * browser had to download, parse and execute the entire wallet stack before
 * React could paint one pixel of the landing page. Measured from a per-package
 * chunk build, that stack is:
 *
 *   @privy-io/react-auth   1198 kB      @reown/appkit-*     ~477 kB
 *   viem                    361 kB      @walletconnect/*    ~575 kB
 *   @base-org/account       226 kB      libphonenumber-js    158 kB
 *   ox                      103 kB      @coinbase/wallet-sdk  73 kB
 *
 * — roughly 3 MB raw / ~800 kB gzipped of code whose only job is to let
 * someone connect a wallet, blocking a page whose job is to show a menu. On a
 * mid-range phone that is seconds of parse time before first paint.
 *
 * THE SHAPE OF THE FIX (and why it is not just React.lazy)
 * -------------------------------------------------------
 * The obvious move — lazily rendering the provider around the app — does
 * not work. Swapping a provider IN above the tree changes the tree's shape,
 * so React unmounts and remounts everything below it. The app would blink and
 * lose all its state (which view you are on, which lobby you opened) a second
 * after load.
 *
 * So the provider never wraps the app at all. Instead:
 *
 *   <AuthCtx.Provider>          ← always here, stable position, never remounts
 *     <PrivyProvider>        ← appears later, as a SIBLING of the app
 *       <PrivyBridge />         ← renders nothing; calls Privy's hooks and
 *     </PrivyProvider>          pushes their values up into AuthCtx
 *     {children}                ← the whole app, mounted once, outside Privy
 *   </AuthCtx.Provider>
 *
 * `children` sits at a fixed position under a provider that is always present,
 * so it mounts exactly once. Privy's login modal still works: it portals to
 * document.body, so being a sibling rather than an ancestor makes no
 * difference to it.
 *
 * Consumers call `useAuth()` instead of `usePrivy()` / `useWallets()`. That is
 * also why they CAN'T call the Privy hooks any more — outside the provider
 * those throw. The five files that used them now read this context.
 *
 * WHEN THE CHUNK LOADS
 * --------------------
 * On idle right after first paint, so a returning user's session is restored
 * almost immediately and the deferral is invisible — or instantly on the first
 * `login()` if the user beats the idle callback to it. `login()` before the
 * SDK is up is not dropped: it is remembered and replayed by the bridge the
 * moment Privy reports ready (see `pendingLogin`).
 */

import React from "react";
// TYPE-ONLY — erased at build time, so this does NOT pull the SDK into this
// chunk. Every runtime Privy import in the app lives behind the dynamic
// import() below.
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";

export interface AuthState {
  /** The Privy chunk has mounted and its hooks are reporting. */
  loaded: boolean;
  /** Privy's own `ready` — false until it has restored any prior session. */
  ready: boolean;
  authenticated: boolean;
  wallets: ConnectedStandardSolanaWallet[];
  /** Opens the wallet modal, loading the SDK first if it isn't up yet. */
  login: () => void;
  logout: () => Promise<void>;
  /** null until loaded. Used by useBackendAuth for the sign-in signature. */
  signMessage: SignMessageFn | null;
  /** null until loaded. Used by WalletPanel's export-key flow. */
  exportWallet: ExportWalletFn | null;
  /**
   * Privy's own JWTs for the current session, handed to our backend at
   * sign-in so it can tell WHO is signing in rather than only WHICH wallet.
   *
   * That distinction is what stops one person collecting several arcade
   * accounts: Privy gives the same human different wallets depending on
   * how they logged in, but the same user id (and the same verified email)
   * every time. The server checks both tokens against Privy's public JWKS
   * — they are proof, not a hint — and resolves them to the one account
   * that person already owns. See apps/server/src/lib/privyIdentity.ts.
   *
   * Always resolves; every field is null when the SDK is not up, nobody is
   * signed in, or Privy declines to issue that token.
   */
  getPrivyTokens: () => Promise<PrivyTokens>;
}

/** The pair of Privy JWTs the backend accepts as identity evidence. */
export interface PrivyTokens {
  /** Access token — carries the stable Privy user id (`sub`). */
  accessToken: string | null;
  /** Identity token — adds the user's verified emails and linked wallets. */
  identityToken: string | null;
}

const NO_PRIVY_TOKENS: PrivyTokens = { accessToken: null, identityToken: null };

type SignMessageFn = (args: {
  message: Uint8Array;
  wallet: ConnectedStandardSolanaWallet;
  options?: { uiOptions?: { title?: string } };
}) => Promise<{ signature: Uint8Array }>;

type ExportWalletFn = (args: { address: string }) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Module-level load coordination
// ---------------------------------------------------------------------------
// These live outside React because the trigger ("someone clicked Connect")
// and the consumer (the bridge, which does not exist yet at that moment) are
// separated in time by a network fetch.

let startLoad: (() => void) | null = null;
/** A login() that arrived before Privy was ready, waiting to be replayed. */
let pendingLogin = false;

function requestLogin() {
  pendingLogin = true;
  startLoad?.();
}

/** Bridge-only: take the pending login intent, if there is one. */
function consumePendingLogin(): boolean {
  const had = pendingLogin;
  pendingLogin = false;
  return had;
}

/** Bridge-only: queue a login that arrived before Privy was ready. */
function markPendingLogin() {
  pendingLogin = true;
}

const UNLOADED: AuthState = {
  loaded: false,
  ready: false,
  authenticated: false,
  wallets: [],
  login: requestLogin,
  logout: async () => {},
  signMessage: null,
  exportWallet: null,
  getPrivyTokens: async () => NO_PRIVY_TOKENS,
};

const AuthCtx = React.createContext<AuthState>(UNLOADED);

/**
 * The app's single source of auth truth. Mirrors what usePrivy()/useWallets()
 * used to return, plus `loaded` for the window before the SDK arrives.
 */
export function useAuth(): AuthState {
  return React.useContext(AuthCtx);
}

// ---------------------------------------------------------------------------
// Login-complete notification
// ---------------------------------------------------------------------------
// App.tsx needs the same immediate signal Privy's `useLogin({ onComplete })`
// gave it. The bridge owns that hook now, so it fans the event out here.

type LoginListener = () => void;
const loginListeners = new Set<LoginListener>();

/** Bridge-only: announce that a login just completed. */
function emitLoginComplete() {
  loginListeners.forEach((fn) => fn());
}

/** Fires right after a fresh sign-in completes (not on session restore). */
export function useOnLoginComplete(cb: LoginListener) {
  // Held in a ref so callers can pass an inline closure without
  // re-subscribing on every render.
  const ref = React.useRef(cb);
  ref.current = cb;
  React.useEffect(() => {
    const fn = () => ref.current();
    loginListeners.add(fn);
    return () => {
      loginListeners.delete(fn);
    };
  }, []);
}

// ---------------------------------------------------------------------------
// The bridge + the provider
// ---------------------------------------------------------------------------

/**
 * Loaded dynamically. Bundles into its own chunk together with everything the
 * Privy SDK drags in — which is the entire point of this file.
 *
 * PrivyBridge is imported from the same module as the provider so the two land
 * in ONE chunk; splitting them would mean a second round-trip before auth
 * works.
 */
/**
 * Load the runtime chunk, retrying a transient failure.
 *
 * `import()` rejects on ANY network hiccup — a request aborted because the
 * page navigated mid-flight, a dropped connection, a proxy blip, a deploy
 * that replaced the file while someone had the app open. React.lazy caches
 * that rejection, so one unlucky moment is permanent for the life of the
 * page.
 *
 * For this chunk that is severe out of proportion to the cause. It carries
 * the entire wallet SDK, so if it never arrives there is no `signMessage`
 * and no wallet list — the account screen waits on a signature prompt that
 * cannot possibly open, and sits on "Signing you in" forever. The
 * observed failure was exactly this:
 *
 *   TypeError: Failed to fetch dynamically imported module: …/privyRuntime-*.js
 *
 * It is also the largest chunk in the app (~4 MB), which makes it the most
 * likely one to be interrupted on a slow or shaky connection — the
 * machines other people are using, in other words.
 *
 * Two retries with a short backoff turn the common transient case into a
 * delay instead of a dead end. A genuinely missing file still fails, and
 * still surfaces — this only buys back the flaky cases.
 */
async function loadPrivyRuntime(attempt = 0): Promise<typeof import("./privyRuntime")> {
  try {
    return await import("./privyRuntime");
  } catch (err) {
    if (attempt >= 2) {
      console.error(
        "[auth] the wallet SDK chunk could not be loaded after 3 attempts — " +
          "wallet sign-in cannot work on this page load:",
        err,
      );
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
    return loadPrivyRuntime(attempt + 1);
  }
}

const PrivyRuntime = React.lazy(() =>
  loadPrivyRuntime().then((m) => ({ default: m.PrivyRuntime })),
);

export function DeferredAuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AuthState>(UNLOADED);
  const [shouldLoad, setShouldLoad] = React.useState(false);

  React.useEffect(() => {
    startLoad = () => setShouldLoad(true);

    // Idle, not immediate: let the landing page paint and settle first. The
    // 2s timeout is the ceiling — on a busy main thread requestIdleCallback
    // can otherwise wait a long time, and a returning user should not see
    // their signed-in state appear late.
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | undefined;
    let timerId: number | undefined;
    if (w.requestIdleCallback) {
      idleId = w.requestIdleCallback(() => setShouldLoad(true), { timeout: 2000 });
    } else {
      timerId = window.setTimeout(() => setShouldLoad(true), 1200);
    }

    return () => {
      startLoad = null;
      if (idleId !== undefined) w.cancelIdleCallback?.(idleId);
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, []);

  // UNLOADED itself, not a copy: its `login` is already `requestLogin` (which
  // queues the intent and kicks off the load), and returning the shared
  // constant keeps the context value referentially stable for the whole
  // pre-load window, so consumers don't re-render for nothing.
  const value = state.loaded ? state : UNLOADED;

  return (
    <AuthCtx.Provider value={value}>
      {/* Sibling, never an ancestor of `children` — see the header comment. */}
      {shouldLoad && (
        <React.Suspense fallback={null}>
          <PrivyRuntime
            onState={setState}
            onLoginComplete={emitLoginComplete}
            consumePendingLogin={consumePendingLogin}
            markPendingLogin={markPendingLogin}
          />
        </React.Suspense>
      )}
      {children}
    </AuthCtx.Provider>
  );
}

export type { SignMessageFn, ExportWalletFn };
