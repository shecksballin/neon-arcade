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
 * It depends on whether this browser has a session to restore — see
 * `hasPriorSession` below, which is where the policy actually lives:
 *
 *   RETURNING USER (a stored session)   on idle right after first paint, so
 *                                       their signed-in state appears almost
 *                                       immediately and the deferral is
 *                                       invisible.
 *   FIRST-TIME VISITOR (no session)     NOT AT ALL until they show intent —
 *                                       `prefetchAuth()` on hovering Connect,
 *                                       or `login()` on clicking it.
 *
 * The old behaviour was "on idle, for everyone", which meant every visitor
 * downloaded 1.26 MB gzip of wallet SDK to look at a menu.
 *
 * `login()` before the SDK is up is never dropped: it is remembered and
 * replayed by the bridge the moment Privy reports ready (see `pendingLogin`).
 */

import React from "react";
// TYPE-ONLY — erased at build time, so this does NOT pull the SDK into this
// chunk. Every runtime Privy import in the app lives behind the dynamic
// import() below.
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";

export interface AuthState {
  /** The Privy chunk has mounted and its hooks are reporting. */
  loaded: boolean;
  /**
   * The wallet chunk is ON ITS WAY but not here yet.
   *
   * Needed because "not loaded" stopped meaning "loading". The SDK is no
   * longer fetched on every page load, so `loaded: false` now covers two very
   * different situations, and UI that cannot tell them apart gets it wrong:
   *   loading: true   → a session is being restored / a sign-in was asked for
   *                     → "Connecting…" is honest
   *   loading: false  → nobody has asked for the wallet and nothing is coming
   *                     → say "Sign in", not "Connecting…", which would spin
   *                       for ever.
   */
  loading: boolean;
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
   * Create the embedded Solana wallet this login should already have.
   *
   * `embeddedWallets.solana.createOnLogin` normally does this at sign-up,
   * but it is not guaranteed: it can be skipped or fail (a blocked Privy
   * iframe, a dropped network, a login that predates the setting), and the
   * result is a Privy user with NO wallet — nothing to sign in with, and
   * no way for the player to fix it from the UI. One such account is how
   * this hook came to exist. Null until the SDK is up; rejects when a
   * wallet already exists, so callers must only reach for it when the
   * wallet list is genuinely empty.
   */
  createWallet: CreateWalletFn | null;
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

/** Privy's Solana `createWallet` — resolves once the wallet exists. */
type CreateWalletFn = () => Promise<unknown>;

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

/**
 * Warm the wallet chunk on INTENT, without mounting anything.
 *
 * Call it from `onPointerEnter` / `onFocus` of any control that leads to
 * sign-in. By the time the click lands the module is already in the module
 * map, so `login()` opens the modal with no download to wait for — even
 * though a visitor who never goes near those controls downloaded nothing.
 *
 * DOWNLOAD ONLY, DELIBERATELY. It does not call `startLoad()`, because that
 * would render `<PrivyRuntime>` and initialise the SDK — which makes a real
 * request to auth.privy.io. Hovering a button should not talk to anyone's
 * server; it should only fetch a file. The mount still happens on click.
 *
 * Deduped, so hovering ten times starts one download, and failures are
 * swallowed: a prefetch that does not arrive is not an error, it just means
 * the click pays for the fetch as it would have anyway.
 */
let prefetching: Promise<unknown> | null = null;
export function prefetchAuth() {
  prefetching ??= loadPrivyRuntime().catch(() => {});
}

// ---------------------------------------------------------------------------
// Should we load the wallet SDK without being asked?
// ---------------------------------------------------------------------------
/**
 * The storage key our own backend session token lives under. Duplicated
 * rather than imported: hooks/useBackendAuth.ts imports `useAuth` from this
 * module, so importing its constant back would be a cycle. lib/api.ts reads
 * the same literal for the Authorization header — if it ever changes, it
 * changes in three places.
 */
const BACKEND_TOKEN_KEY = 'token';

/**
 * Is there any evidence this browser has signed in before?
 *
 * THIS IS THE WHOLE POLICY. The wallet SDK is 1.26 MB gzipped — by a wide
 * margin the heaviest thing the app can download — and a first-time visitor
 * looking at the landing page needs exactly none of it. It used to load on
 * idle for EVERYONE, which put that 1.26 MB on the critical path of every
 * cold load in exchange for a faster signed-in badge for the minority who
 * had a session to restore.
 *
 * So: restore eagerly for people who have something to restore, and let
 * everyone else pay nothing until they show intent (clicking Connect, or
 * merely hovering it — see prefetchAuth).
 *
 * The signals, cheapest first, all readable without touching the SDK:
 *   - our own backend JWT, written after a completed arcade sign-in;
 *   - Privy's persisted session keys, written when Privy has a session of
 *     its own to restore. `privy:caid` is deliberately NOT one of them: it
 *     is a device id Privy writes for anonymous visitors too, so treating it
 *     as evidence would re-load the SDK for everybody and undo all of this.
 *
 * Wrapped in try/catch because localStorage throws outright in some privacy
 * modes and inside partitioned third-party contexts. Failing closed (no
 * auto-load) is the right default: the user can still click Connect.
 */
function hasPriorSession(): boolean {
  try {
    /**
     * THE RETURN LEG OF A REDIRECT LOGIN — check this FIRST.
     *
     * "Google" is one of the configured login methods, and Privy's OAuth is a
     * full-page navigation, not a popup: the browser leaves the arcade, comes
     * back to `/?privy_oauth_code=…&privy_oauth_state=…`, and the SDK
     * completes the sign-in by exchanging that code on init.
     *
     * At that instant the visitor has NO session yet — that is the whole
     * point of the round trip — so every token check below is false. Without
     * this branch the SDK would never load, the code would never be
     * exchanged, and anyone signing in with Google would be dumped back on a
     * signed-out landing page with a stale code in the URL. This is a load
     * where the wallet chunk is mandatory, not optional.
     *
     * Param and key names read from @privy-io/react-auth 3.35.2.
     */
    const params = new URLSearchParams(window.location.search);
    if (params.has('privy_oauth_code') || params.has('privy_oauth_state')) return true;
    // The other half of the same flow: Privy stashes the PKCE verifier and
    // state before navigating away, so their presence means a login is
    // mid-flight even if the query string has already been cleaned up.
    if (
      window.localStorage.getItem('privy:code_verifier') ||
      window.localStorage.getItem('privy:state_code')
    ) {
      return true;
    }

    if (window.localStorage.getItem(BACKEND_TOKEN_KEY)) return true;
    // The exact keys @privy-io/react-auth 3.x writes for a live session,
    // read out of the installed package rather than assumed. `privy:caid` is
    // deliberately NOT among them: that one is a device id Privy writes for
    // anonymous visitors too, so treating it as evidence would auto-load the
    // SDK for everybody and undo this entire change.
    for (const key of ['privy:token', 'privy:refresh_token', 'privy:id_token']) {
      if (window.localStorage.getItem(key)) return true;
    }
  } catch {
    /* storage unavailable — treat as "no session", i.e. do not auto-load */
  }
  return false;
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
  loading: false,
  ready: false,
  authenticated: false,
  wallets: [],
  login: requestLogin,
  logout: async () => {},
  signMessage: null,
  exportWallet: null,
  createWallet: null,
  getPrivyTokens: async () => NO_PRIVY_TOKENS,
};

/**
 * Same as UNLOADED, but the chunk is in flight. A separate module constant
 * rather than a computed object so the context value stays referentially
 * stable for the whole pre-load window — consumers must not re-render just
 * because the loading flag was recreated.
 */
const UNLOADED_LOADING: AuthState = { ...UNLOADED, loading: true };

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

    /**
     * ONLY returning users pay for the SDK up front.
     *
     * A visitor with no stored session gets nothing here: the chunk is
     * fetched when they hover or click Connect (requestLogin / prefetchAuth).
     * That is the difference between a 1.26 MB cold load and a 0 MB one, and
     * it costs a first-time visitor nothing they can perceive — they were
     * never going to be signed in anyway.
     *
     * For someone WITH a session the old behaviour is exactly preserved:
     * load on idle so their signed-in state appears almost immediately. The
     * 2s timeout is the ceiling — on a busy main thread requestIdleCallback
     * can otherwise wait a long time, and a returning user should not see
     * their signed-in state appear late.
     */
    if (!hasPriorSession()) {
      return () => {
        startLoad = null;
      };
    }

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

  // A shared constant, not a copy: its `login` is already `requestLogin`
  // (which queues the intent and kicks off the load), and returning the same
  // object keeps the context value referentially stable for the whole
  // pre-load window, so consumers don't re-render for nothing. Which of the
  // two it is tells consumers whether anything is actually coming.
  const value = state.loaded ? state : shouldLoad ? UNLOADED_LOADING : UNLOADED;

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

export type { SignMessageFn, ExportWalletFn, CreateWalletFn };
