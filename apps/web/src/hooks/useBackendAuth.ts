/**
 * useBackendAuth
 * ==============
 * The bridge between Privy (proves wallet ownership) and OUR backend
 * (issues the JWT the Hono API trusts).
 *
 * Flow:
 * 1. Get a one-time nonce from the backend (2-minute expiry)
 * 2. Sign it with the Privy wallet — proves we own the address.
 *    Embedded wallets show a small Privy confirmation UI; external
 *    wallets (Phantom) pop their own signature prompt.
 * 3. Backend verifies the ed25519 signature and mints a JWT
 * 4. The JWT is stored and lib/api.ts attaches it as
 *    `Authorization: Bearer` on every request from then on.
 *
 * v3 note: useSignMessage comes from the /solana entrypoint and returns
 * `{ signature: Uint8Array }` — bs58-encode it before sending.
 */

import { useSignMessage, useWallets } from '@privy-io/react-auth/solana'
import bs58 from 'bs58'
import { buildSignInMessage, SIGN_IN_MESSAGE_TITLE } from '@neon/types'
import { authApi } from '../lib/api'
import { pickPrimaryWallet } from './useWalletAddress'

// Same key lib/api.ts reads when attaching the Authorization header
export const AUTH_TOKEN_KEY = 'token'

// Module-level so React 18 StrictMode double-mounts (and any two
// components calling signIn at once) share ONE in-flight sign-in
// instead of popping two signature prompts.
let inFlight: Promise<string> | null = null

export function useBackendAuth() {
  const { signMessage } = useSignMessage()
  const { wallets } = useWallets()

  async function doSignIn(): Promise<string> {
    const wallet = pickPrimaryWallet(wallets)
    if (!wallet) throw new Error('No wallet available')

    const address = wallet.address

    // 1. One-time nonce from the backend
    const { nonce } = await authApi.getNonce(address)

    // 2. Sign the exact message the server will verify (shared builder
    //    in @neon/types so client and server can never drift)
    const message = new TextEncoder().encode(buildSignInMessage(nonce))
    const result = await signMessage({
      message,
      wallet,
      options: { uiOptions: { title: SIGN_IN_MESSAGE_TITLE } },
    })

    // 3. Backend verifies the signature and mints our session JWT
    const signature = bs58.encode(result.signature)
    const { token } = await authApi.verify(address, signature, nonce)

    // 4. Store it for authenticated API calls
    localStorage.setItem(AUTH_TOKEN_KEY, token)
    return token
  }

  function signIn(): Promise<string> {
    if (!inFlight) {
      inFlight = doSignIn().finally(() => {
        inFlight = null
      })
    }
    return inFlight
  }

  /** Forget the backend session (call alongside Privy logout). */
  function clearSession() {
    localStorage.removeItem(AUTH_TOKEN_KEY)
  }

  return { signIn, clearSession }
}
