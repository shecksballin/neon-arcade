/**
 * PRIVY PROVIDER
 * ==============
 * Wraps the whole app (mounted in main.tsx). Configures:
 * - Login methods shown in the modal (wallet + email + Google)
 * - Auto-creation of an embedded Solana wallet for users without one
 * - Solana RPC endpoints (devnet while testing)
 * - Neon-styled dark appearance
 *
 * v3 notes:
 * - Solana wallet connectors come from the /solana entrypoint
 * - RPCs are configured via `solana.rpcs` with @solana/kit
 *   (createSolanaRpc replaced the old @solana/web3.js Connection)
 * - Embedded wallets are created just AFTER first login completes, so
 *   useWallets() can be briefly empty right as `authenticated` flips
 *   true — App.tsx waits for the wallet before backend sign-in.
 */

import { PrivyProvider } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit'
import type { ReactNode } from 'react'

// Devnet now (testing). For production, point these at mainnet — and
// ideally a paid RPC (Helius/QuickNode) rather than the public endpoint.
// The mainnet entry below exists so nothing breaks if an SDK action
// defaults to 'solana:mainnet'; nothing connects until it's used.
const DEVNET_RPC_URL = 'https://api.devnet.solana.com'
const DEVNET_WS_URL = 'wss://api.devnet.solana.com'
const MAINNET_RPC_URL = 'https://api.mainnet-beta.solana.com'
const MAINNET_WS_URL = 'wss://api.mainnet-beta.solana.com'

// Public (not secret) app id from the Privy dashboard. Locally it comes
// from Doppler (VITE_PRIVY_APP_ID) through `doppler run -- turbo dev`,
// or from apps/web/.env. Privy hard-throws unless the id is a 25-char
// string, so when it's missing/malformed we substitute a placeholder:
// the app still renders and plays, wallet login just stays disabled.
// trim() guards against stray whitespace sneaking into the secret value
const appId: string | undefined = import.meta.env.VITE_PRIVY_APP_ID?.trim()
const PLACEHOLDER_APP_ID = 'privy-app-id-not-set-xxxx' // exactly 25 chars

export function AppPrivyProvider({ children }: { children: ReactNode }) {
  if (!appId || appId.length !== 25) {
    console.error(
      '[Privy] VITE_PRIVY_APP_ID is missing or malformed — wallet login is disabled. ' +
        'Add the 25-character app id from dashboard.privy.io to Doppler (VITE_PRIVY_APP_ID) or apps/web/.env.'
    )
  }

  return (
    <PrivyProvider
      appId={appId && appId.length === 25 ? appId : PLACEHOLDER_APP_ID}
      config={{
        // Which login options appear in the modal
        loginMethods: ['wallet', 'email', 'google'],

        // Auto-create an embedded Solana wallet for users who sign in
        // without one (email/Google users). External-wallet users keep
        // using their own. Options: 'all-users' | 'users-without-wallets' | 'off'
        embeddedWallets: {
          solana: {
            createOnLogin: 'users-without-wallets',
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
            'solana:devnet': {
              rpc: createSolanaRpc(DEVNET_RPC_URL),
              rpcSubscriptions: createSolanaRpcSubscriptions(DEVNET_WS_URL),
              blockExplorerUrl: 'https://explorer.solana.com?cluster=devnet',
            },
            'solana:mainnet': {
              rpc: createSolanaRpc(MAINNET_RPC_URL),
              rpcSubscriptions: createSolanaRpcSubscriptions(MAINNET_WS_URL),
              blockExplorerUrl: 'https://explorer.solana.com',
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
          theme: '#081616',
          accentColor: '#00FFD1',
          walletChainType: 'solana-only',
          logo: '/NeonArcadeLogo.png',
          landingHeader: 'Welcome to Neon Arcade',
          loginMessage: 'Sign in to start playing',
        },
      }}
    >
      {children}
    </PrivyProvider>
  )
}
