/**
 * PRIVY RUNTIME — everything that must not be in the entry chunk
 * =============================================================
 * This module is reached ONLY through the dynamic import in ./index.tsx, so
 * every static import here (the Privy SDK, its Solana entrypoint, @solana/kit
 * and the whole wallet-connector tree they pull in) lands in a separate chunk
 * that the landing page never downloads. Read ./index.tsx first — it explains
 * why the provider is a sibling of the app rather than its ancestor.
 *
 * Keep this file's imports tight. Anything imported here is auth-chunk weight;
 * anything imported here that the app ALSO uses gets duplicated or hoisted
 * back into the entry chunk by Rollup, which would quietly undo the split.
 */

import React from "react";
import {
  PrivyProvider,
  usePrivy,
  useLogin,
  useIdentityToken,
} from "@privy-io/react-auth";
import {
  toSolanaWalletConnectors,
  useWallets,
  useSignMessage,
  useExportWallet,
} from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import type {
  AuthState,
  SignMessageFn,
  ExportWalletFn,
  PrivyTokens,
} from "./index";

// Devnet now (testing). For production, point these at mainnet — and
// ideally a paid RPC (Helius/QuickNode) rather than the public endpoint.
// The mainnet entry below exists so nothing breaks if an SDK action
// defaults to 'solana:mainnet'; nothing connects until it's used.
const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const DEVNET_WS_URL = "wss://api.devnet.solana.com";
const MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";
const MAINNET_WS_URL = "wss://api.mainnet-beta.solana.com";

// Public (not secret) app id from the Privy dashboard. Locally it comes
// from Doppler (VITE_PRIVY_APP_ID) through `doppler run -- turbo dev`,
// or from apps/web/.env. Privy hard-throws unless the id is a 25-char
// string, so when it's missing/malformed we substitute a placeholder:
// the app still renders and plays, wallet login just stays disabled.
// trim() guards against stray whitespace sneaking into the secret value
const appId: string | undefined = import.meta.env.VITE_PRIVY_APP_ID?.trim();
const PLACEHOLDER_APP_ID = "privy-app-id-not-set-xxxx"; // exactly 25 chars

interface RuntimeProps {
  onState: (s: AuthState) => void;
  onLoginComplete: () => void;
  consumePendingLogin: () => boolean;
  markPendingLogin: () => void;
}

export function PrivyRuntime(props: RuntimeProps) {
  if (!appId || appId.length !== 25) {
    console.error(
      "[Privy] VITE_PRIVY_APP_ID is missing or malformed — wallet login is disabled. " +
        "Add the 25-character app id from dashboard.privy.io to Doppler (VITE_PRIVY_APP_ID) or apps/web/.env.",
    );
  }

  return (
    <PrivyProvider
      appId={appId && appId.length === 25 ? appId : PLACEHOLDER_APP_ID}
      config={{
        // Which login options appear in the modal
        loginMethods: ["wallet", "email", "google"],

        // Auto-create an embedded Solana wallet for users who sign in
        // without one (email/Google users). External-wallet users keep
        // using their own. Options: 'all-users' | 'users-without-wallets' | 'off'
        embeddedWallets: {
          solana: {
            createOnLogin: "users-without-wallets",
          },
        },

        // External wallet connectors (Phantom, Backpack, etc.)
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors(),
          },
        },

        // Which RPCs the SDK talks to, per chain
        solana: {
          rpcs: {
            "solana:devnet": {
              rpc: createSolanaRpc(DEVNET_RPC_URL),
              rpcSubscriptions: createSolanaRpcSubscriptions(DEVNET_WS_URL),
              blockExplorerUrl: "https://explorer.solana.com?cluster=devnet",
            },
            "solana:mainnet": {
              rpc: createSolanaRpc(MAINNET_RPC_URL),
              rpcSubscriptions: createSolanaRpcSubscriptions(MAINNET_WS_URL),
              blockExplorerUrl: "https://explorer.solana.com",
            },
          },
        },

        // Match the neon theme (see pivyWalletDesign.txt). `theme` takes a
        // custom hex — Privy auto-generates the rest of the palette from it,
        // so we feed it the app background (#081616, well under 20% luminance
        // so modal text stays readable). accentColor drives buttons/links.
        // Finer control (borders, radius) lives in the --privy-* CSS vars in
        // index.css. Logo + header/subtext brand the modal itself.
        appearance: {
          theme: "#081616",
          accentColor: "#00FFD1",
          walletChainType: "solana-only",
          logo: "/NeonArcadeLogo.png",
          landingHeader: "Welcome to Neon Arcade",
          loginMessage: "Sign in to start playing",
        },
      }}
    >
      <PrivyBridge {...props} />
    </PrivyProvider>
  );
}

/**
 * Renders nothing. Its whole job is to sit inside the provider, call the
 * hooks that only work there, and publish the results to the AuthCtx that the
 * rest of the app reads.
 */
function PrivyBridge({
  onState,
  onLoginComplete,
  consumePendingLogin,
  markPendingLogin,
}: RuntimeProps) {
  const { ready, authenticated, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { exportWallet } = useExportWallet();
  const { login } = useLogin({ onComplete: onLoginComplete });
  // Privy's second JWT: same subject as the access token, plus the user's
  // verified emails and linked wallets. Our backend uses it to recognise
  // one person across two Privy user ids (email login vs Google login on
  // the same address). Apps without identity tokens enabled just get null,
  // which the server treats as "no extra evidence" rather than an error.
  const { identityToken } = useIdentityToken();

  /**
   * EVERY VALUE FROM PRIVY, HELD IN ONE REF.
   *
   * This is the load-bearing detail of the whole bridge. Publishing state
   * upward re-renders DeferredAuthProvider, which re-renders this component —
   * so if the publish effect depended on the IDENTITY of Privy's functions
   * (`login`, `logout`, `signMessage`, `exportWallet`) and any one of them were
   * a fresh closure per render, the effect would fire again, publish again,
   * and spin forever. Privy makes no documented stability guarantee for them,
   * and a render loop is not something to leave to chance.
   *
   * So the functions never appear in a dependency array. They live in a ref
   * refreshed on every render, and what the app receives are the permanently
   * stable wrappers below. The effect then keys on DATA only — ready,
   * authenticated, and the wallet addresses — which is exactly what should
   * cause a re-publish.
   */
  const latest = React.useRef({
    login,
    logout,
    signMessage,
    exportWallet,
    getAccessToken,
    identityToken,
    ready,
    authenticated,
  });
  latest.current = {
    login,
    logout,
    signMessage,
    exportWallet,
    getAccessToken,
    identityToken,
    ready,
    authenticated,
  };

  /**
   * The `login` the app actually gets. Privy's own is only meaningful once
   * `ready` — calling it during initialisation is silently dropped, which
   * would strand anyone who clicks Connect in that window. This one queues
   * instead, and the replay effect below opens the modal when Privy is up.
   * Callers therefore never have to check readiness first.
   */
  const safeLogin = React.useCallback(() => {
    const l = latest.current;
    if (!l.ready) {
      markPendingLogin();
      return;
    }
    if (l.authenticated) return;
    l.login();
  }, [markPendingLogin]);

  const stableLogout = React.useCallback(() => latest.current.logout(), []);
  const stableSignMessage = React.useCallback<SignMessageFn>(
    (args) => latest.current.signMessage(args),
    [],
  );
  const stableExportWallet = React.useCallback<ExportWalletFn>(
    (args) => latest.current.exportWallet(args),
    [],
  );

  /**
   * Reads BOTH tokens through the ref, so it stays referentially stable
   * even though `identityToken` changes as Privy refreshes it — putting it
   * in the published state instead would re-run the publish effect on
   * every rotation for no benefit.
   *
   * Never throws: a token that cannot be produced (SDK mid-init, signed
   * out, identity tokens disabled for this app) comes back as null, and
   * the backend falls back to wallet-only matching.
   */
  const stableGetPrivyTokens = React.useCallback(async (): Promise<PrivyTokens> => {
    const l = latest.current;
    let accessToken: string | null = null;
    try {
      accessToken = (await l.getAccessToken()) ?? null;
    } catch {
      accessToken = null;
    }
    return { accessToken, identityToken: l.identityToken ?? null };
  }, []);

  // `wallets` is a fresh array identity on every render from Privy, so the
  // effect keys on the addresses it contains rather than on the array itself.
  const walletKey = wallets.map((w) => w.address).join(",");

  React.useEffect(() => {
    onState({
      loaded: true,
      ready,
      authenticated,
      wallets,
      login: safeLogin,
      logout: stableLogout,
      signMessage: stableSignMessage,
      exportWallet: stableExportWallet,
      getPrivyTokens: stableGetPrivyTokens,
    });
    // wallets is intentionally tracked via walletKey — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ready,
    authenticated,
    walletKey,
    onState,
    safeLogin,
    stableLogout,
    stableSignMessage,
    stableExportWallet,
    stableGetPrivyTokens,
  ]);

  // Replay a login() that was clicked before the SDK finished loading. If the
  // user turned out to already have a session, there is nothing to open —
  // App's own follow-up effect takes it from there.
  React.useEffect(() => {
    if (!ready) return;
    if (!consumePendingLogin()) return;
    if (authenticated) return;
    latest.current.login();
  }, [ready, authenticated, consumePendingLogin]);

  return null;
}
