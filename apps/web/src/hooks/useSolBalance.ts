/**
 * useSolBalance
 * =============
 * Reads a wallet's SOL balance from the devnet RPC for display in the
 * wallet panel. Fetches on mount / when the address changes, and exposes
 * refresh() for a manual re-check (e.g. after funding). Read-only.
 */

import { useCallback, useEffect, useState } from 'react'
import { getSolBalance } from '../lib/solana'

export function useSolBalance(walletAddress: string | null) {
  const [balance, setBalance] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!walletAddress) {
      setBalance(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setBalance(await getSolBalance(walletAddress))
    } catch {
      setError('Could not load balance')
    } finally {
      setLoading(false)
    }
  }, [walletAddress])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { balance, loading, error, refresh }
}
