/**
 * useWalletAddress
 * ================
 * Returns the user's Solana wallet address (embedded or external),
 * or null if not ready / not logged in.
 *
 * Both embedded (Privy-created) and external (Phantom) wallets show up
 * in the same useWallets array — your backend treats them identically.
 */

import { usePrivy } from '@privy-io/react-auth'
import { useWallets } from '@privy-io/react-auth/solana'

export function useWalletAddress(): {
  address: string | null
  ready: boolean
  authenticated: boolean
} {
  const { ready, authenticated } = usePrivy()
  const { wallets } = useWallets()

  // Prefer the embedded Privy wallet; fall back to any connected Solana wallet
  const embedded = wallets.find(w => w.walletClientType === 'privy')
  const wallet = embedded ?? wallets[0]

  return {
    address: wallet?.address ?? null,
    ready,
    authenticated,
  }
}
