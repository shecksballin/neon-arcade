/**
 * useBackendAuth
 * ==============
 * The bridge between Privy (proves wallet ownership) and YOUR backend
 * (issues a JWT your Hono API trusts).
 *
 * Flow:
 * 1. Get a one-time nonce from your backend
 * 2. Sign it with the Privy wallet (proves they own the address)
 * 3. Send { address, signature, nonce } to your backend
 * 4. Backend verifies the signature, issues a JWT
 * 5. Store the JWT for authenticated API calls
 *
 * v3 note: useSignMessage comes from the /solana entrypoint, and
 * signMessage returns an object whose .signature is a Uint8Array —
 * bs58-encode it before sending to the backend.
 */

import { useSignMessage, useWallets } from '@privy-io/react-auth/solana'
import bs58 from 'bs58'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

export function useBackendAuth() {
  const { signMessage } = useSignMessage()
  const { wallets } = useWallets()

  async function signIn(): Promise<string> {
    const wallet = wallets.find(w => w.walletClientType === 'privy') ?? wallets[0]
    if (!wallet) throw new Error('No wallet available')

    const address = wallet.address

    // 1. Get a nonce from the backend
    const nonceRes = await fetch(`${API_URL}/api/auth/nonce?wallet=${address}`)
    if (!nonceRes.ok) throw new Error('Failed to get nonce')
    const { nonce } = await nonceRes.json()

    // 2. Sign the nonce message
    const message = new TextEncoder().encode(
      `Sign in to Neon Arcade\nNonce: ${nonce}`
    )
    const result = await signMessage({
      message,
      wallet,
      options: { uiOptions: { title: 'Sign in to Neon Arcade' } },
    })

    // 3. Encode the signature and send to backend
    const signature = bs58.encode(result.signature)
    const verifyRes = await fetch(`${API_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: address, signature, nonce }),
    })
    if (!verifyRes.ok) throw new Error('Signature verification failed')

    const { token } = await verifyRes.json()

    // 4. Store the JWT for future API calls
    localStorage.setItem('token', token)
    return token
  }

  return { signIn }
}
