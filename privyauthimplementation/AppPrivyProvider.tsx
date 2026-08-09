/**
 * PRIVY PROVIDER
 * ==============
 * Wraps your whole app. Configures:
 * - Login methods (wallet + social)
 * - Embedded Solana wallet auto-creation
 * - Solana devnet cluster (switch to mainnet-beta for production)
 *
 * v3 notes:
 * - Solana wallet connectors come from the /solana entrypoint
 * - @solana/kit replaces the old @solana/web3.js (Connection -> createSolanaRpc)
 * - Embedded wallets are created AFTER first login, not during the callback
 */

import { PrivyProvider } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'
import { ReactNode } from 'react'

// Devnet now (testing). For production, swap both URLs to mainnet-beta
// and ideally a paid RPC (Helius/QuickNode) rather than the public endpoint.
const SOLANA_CLUSTER = 'devnet'
const SOLANA_RPC_URL = 'https://api.devnet.solana.com'

export function AppPrivyProvider({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider
      appId={import.meta.env.VITE_PRIVY_APP_ID}
      config={{
        // Which login options appear in the modal
        loginMethods: ['wallet', 'email', 'google'],

        // Auto-create an embedded Solana wallet for users who don't have one.
        // Options: 'all-users' | 'users-without-wallets' | 'off'
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

        // Which Solana cluster + RPC the app talks to
        solanaClusters: [
          { name: SOLANA_CLUSTER, rpcUrl: SOLANA_RPC_URL },
        ],

        // Match your neon theme
        appearance: {
          theme: 'dark',
          accentColor: '#00FFD1',
          walletChainType: 'solana-only',
        },
      }}
    >
      {children}
    </PrivyProvider>
  )
}
