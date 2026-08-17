/**
 * LoginButton
 * ===========
 * Drop this anywhere. Handles login (opens Privy modal with
 * wallet + social options) and logout.
 *
 * `ready` guards against acting before Privy has initialized —
 * always check it before reading auth state.
 */

import { usePrivy } from '@privy-io/react-auth'
import { useWalletAddress } from '../hooks/useWalletAddress'

export function LoginButton() {
  const { ready, authenticated, login, logout } = usePrivy()
  const { address } = useWalletAddress()

  // Don't render actions until Privy is initialized
  if (!ready) {
    return <button disabled>Loading…</button>
  }

  if (authenticated) {
    return (
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <span style={{ fontFamily: 'monospace', color: '#00FFD1' }}>
          {address ? `${address.slice(0, 4)}…${address.slice(-4)}` : 'No wallet'}
        </span>
        <button onClick={logout}>Disconnect</button>
      </div>
    )
  }

  return <button onClick={login}>Connect Wallet</button>
}
