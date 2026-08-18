/**
 * useWalletAddress
 * ================
 * Returns the user's Solana wallet address (embedded or external),
 * or null if not ready / not logged in.
 *
 * Both embedded (Privy-created) and external (Phantom etc.) wallets
 * show up in the same useWallets() array — the backend treats them
 * identically. When a user somehow has both, we prefer the embedded
 * one so their in-game identity stays stable.
 */

// useAuth(), not usePrivy(): the SDK is loaded lazily and lives OUTSIDE this
// component's tree, so Privy's own hooks would throw here. See src/auth.
// The type import stays — types are erased, so it costs no bundle weight.
import { useAuth } from '../auth'
import type { ConnectedStandardSolanaWallet } from '@privy-io/react-auth/solana'

/**
 * True for the Privy embedded wallet (vs an external one). v3 wallets
 * don't carry the old `walletClientType` field — the embedded wallet is
 * identified by the `privy:` feature on its standard-wallet instance.
 */
export function isEmbeddedWallet(w: ConnectedStandardSolanaWallet): boolean {
  return 'privy:' in w.standardWallet.features
}

/** The wallet the app treats as "the" wallet: embedded first, else the first connected one. */
export function pickPrimaryWallet(
  wallets: ConnectedStandardSolanaWallet[]
): ConnectedStandardSolanaWallet | null {
  return wallets.find(isEmbeddedWallet) ?? wallets[0] ?? null
}

export function useWalletAddress(): {
  address: string | null
  ready: boolean
  authenticated: boolean
  /**
   * The wallet SDK is on its way. Passed through so callers can tell
   * "connecting" from "nothing is coming" — the SDK is only fetched for a
   * returning session or on an explicit sign-in intent, so `!ready` on its
   * own no longer implies anything is loading. See AuthState.loading.
   */
  loading: boolean
} {
  const { ready, authenticated, wallets, loading } = useAuth()

  const wallet = pickPrimaryWallet(wallets)

  return {
    address: wallet?.address ?? null,
    ready,
    authenticated,
    loading,
  }
}
