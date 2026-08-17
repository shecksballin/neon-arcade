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
 * 3. Backend verifies the ed25519 signature — AND the Privy tokens sent
 *    alongside it, which say which PERSON this is rather than only which
 *    wallet — then resolves both to the one account they own and mints a
 *    JWT for it.
 * 4. The JWT is stored and lib/api.ts attaches it as
 *    `Authorization: Bearer` on every request from then on.
 *
 * WHY THE PRIVY TOKENS RIDE ALONG
 * -------------------------------
 * A signature only ever proves an ADDRESS, and Privy hands one person
 * several over time (an embedded wallet from an email login, another from
 * a Google login, Phantom when they connect it). Sending the address on
 * its own therefore made every new wallet look like a new player and
 * pushed them into creating a second account. The tokens carry Privy's own
 * stable user id, which the server verifies against Privy's public JWKS.
 *
 * TWO OTHER WAYS IN
 * -----------------
 * `loginWithCredentials` signs in with the PIN + authenticator code set up
 * during account creation — for when the wallet path lands somewhere new —
 * and `refreshSession` quietly extends a live session on load so an active
 * player is never asked to sign again.
 *
 * v3 note: useSignMessage comes from the /solana entrypoint and returns
 * `{ signature: Uint8Array }` — bs58-encode it before sending.
 */

// useAuth(), not Privy's hooks — the SDK is lazily loaded and mounted outside
// this tree. `signMessage` is null until it arrives; signIn() says so rather
// than throwing something cryptic. See src/auth.
import { useAuth } from '../auth'
// bs58 is imported DYNAMICALLY at the one place it's used (below). App.tsx
// pulls this hook in for `clearSession`, which is a single localStorage
// delete — a static import here put bs58, and therefore the whole chunk it
// is grouped with, into the entry graph as a preload.
import { buildSignInMessage, SIGN_IN_MESSAGE_TITLE } from '@neon/types'
import { ApiError, authApi, type SignInAccount } from '../lib/api'
import { pickPrimaryWallet } from './useWalletAddress'

// Same key lib/api.ts reads when attaching the Authorization header
export const AUTH_TOKEN_KEY = 'token'

// Module-level so React 18 StrictMode double-mounts (and any two
// components calling signIn at once) share ONE in-flight sign-in
// instead of popping two signature prompts.
let inFlight: Promise<string> | null = null

/**
 * How long to wait for the wallet's signature UI before giving up.
 *
 * The wallet call is the one step with no upper bound of its own: if the
 * confirmation UI never opens — the SDK is mid-init, an embedded-wallet
 * iframe is blocked, a browser extension swallowed the request — the
 * promise simply never settles. Generous, because when the prompt DOES
 * open a real person has to find it and read it; but finite, because a
 * spinner that can never end is worse than an error.
 */
const SIGNATURE_TIMEOUT_MS = 60_000

const SIGNATURE_TIMEOUT_MESSAGE =
  'Your wallet never asked you to sign — check for a hidden popup, then try again'

/** Reject if `promise` has not settled inside the signature budget. */
function withSignatureTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(SIGNATURE_TIMEOUT_MESSAGE)),
      SIGNATURE_TIMEOUT_MS
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Abandon a sign-in that is still pending, so the NEXT signIn() starts a
 * genuinely new one.
 *
 * Sharing `inFlight` stops duplicate signature prompts, which is right —
 * but it also meant a single stuck attempt poisoned every retry after it:
 * "Try again" called signIn(), got handed the same never-settling promise,
 * and re-displayed the same label forever. Only a page reload recovered.
 * The retry button calls this first so the deadlock cannot outlive it.
 *
 * The abandoned attempt is left to finish or die on its own; it holds no
 * lock and its nonce simply expires unused.
 */
export function abandonSignIn(): void {
  inFlight = null
}

/** Optional hooks into the sign-in sequence, for accurate progress text. */
export interface SignInOptions {
  /**
   * Fired at the exact moment the wallet is asked to sign — i.e. when
   * "confirm the request in your wallet" becomes true, and not before.
   * Only the call that STARTS an attempt receives this; callers that join
   * an in-flight one do not.
   */
  onAwaitingSignature?: () => void
}

/**
 * Extend a live session without any wallet interaction.
 *
 * Called on load: the stored token is traded for a fresh 30-day one, so a
 * player who keeps visiting stays signed in indefinitely and only ever
 * signs a message on a genuinely new device. Returns the account the
 * session belongs to, or null if there was nothing to refresh — a missing,
 * expired or rejected token is an ordinary outcome here, not an error, and
 * the normal sign-in path takes over.
 *
 * Standalone rather than a hook method: App.tsx runs it once at boot,
 * before anything auth-related has rendered.
 */
export async function refreshSession(): Promise<SignInAccount | null> {
  if (!localStorage.getItem(AUTH_TOKEN_KEY)) return null
  try {
    const { token, account } = await authApi.refresh()
    localStorage.setItem(AUTH_TOKEN_KEY, token)
    return account
  } catch (err) {
    // 401 means the token is past saving — drop it so the sign-in path
    // asks for a signature instead of looping on a dead credential.
    // Anything else (server restarting, offline) leaves it alone: the
    // token may well still be good next time.
    if (err instanceof ApiError && err.status === 401) {
      localStorage.removeItem(AUTH_TOKEN_KEY)
    }
    return null
  }
}

export function useBackendAuth() {
  const { signMessage, wallets, getPrivyTokens } = useAuth()

  async function doSignIn(options: SignInOptions = {}): Promise<string> {
    // Only reachable if a caller runs sign-in before the auth chunk has
    // landed. AccountSetup already waits for a wallet, which implies a loaded
    // SDK, so this is a guard rather than an expected path.
    if (!signMessage) throw new Error('Wallet not ready yet')
    const wallet = pickPrimaryWallet(wallets)
    if (!wallet) throw new Error('No wallet available')

    const address = wallet.address

    // 1. One-time nonce from the backend
    const { nonce } = await authApi.getNonce(address)

    // 2. Sign the exact message the server will verify (shared builder
    //    in @neon/types so client and server can never drift)
    const message = new TextEncoder().encode(buildSignInMessage(nonce))
    // Only NOW is the user actually being asked for anything. Announcing
    // it earlier — before the nonce round trip — is what made a stalled
    // network call look like a wallet waiting on a click that never came.
    options.onAwaitingSignature?.()
    const result = await withSignatureTimeout(
      signMessage({
        message,
        wallet,
        options: { uiOptions: { title: SIGN_IN_MESSAGE_TITLE } },
      })
    )

    // 3. Backend verifies the signature — plus Privy's own tokens, which
    //    tell it which PERSON this is — and mints our session JWT for the
    //    account they already own, if they own one.
    const { default: bs58 } = await import('bs58')
    const signature = bs58.encode(result.signature)
    const privyTokens = await getPrivyTokens()
    const { token } = await authApi.verify(address, signature, nonce, privyTokens)

    // 4. Store it for authenticated API calls
    localStorage.setItem(AUTH_TOKEN_KEY, token)
    return token
  }

  function signIn(options: SignInOptions = {}): Promise<string> {
    if (!inFlight) {
      inFlight = doSignIn(options).finally(() => {
        inFlight = null
      })
    }
    return inFlight
  }

  /**
   * Sign in to an EXISTING account with the credentials from setup: the
   * 4-digit PIN and a live 6-digit code from the authenticator app that
   * scanned the QR.
   *
   * This is the escape hatch for the case automatic recognition cannot
   * cover — a Privy login that produced a wallet the account has never
   * been linked to. Proving the credentials also hands the server the
   * current Privy tokens, so it attaches this login to the account and the
   * ordinary wallet path works unaided next time. One step, once.
   */
  async function loginWithCredentials(
    username: string,
    pin: string,
    code: string
  ): Promise<SignInAccount> {
    const privyTokens = await getPrivyTokens()
    const { token, account } = await authApi.login(username, pin, code, privyTokens)
    localStorage.setItem(AUTH_TOKEN_KEY, token)
    return account
  }

  /** Forget the backend session (call alongside Privy logout). */
  function clearSession() {
    localStorage.removeItem(AUTH_TOKEN_KEY)
  }

  return { signIn, loginWithCredentials, clearSession }
}

/**
 * End the backend session properly: revoke it server-side, THEN forget it
 * locally.
 *
 * The order is load-bearing — revoking needs the token to authenticate
 * with, so dropping it first would leave a live 30-day credential on every
 * other device with a copy. And the local half runs whatever happens to
 * the request: an offline or failing server must never be able to keep
 * somebody signed in on the machine in front of them.
 *
 * Standalone, like refreshSession, so the sign-out path can call it
 * without holding the hook.
 */
export async function endSession(): Promise<void> {
  const hadToken = !!localStorage.getItem(AUTH_TOKEN_KEY)
  try {
    if (hadToken) await authApi.logout()
  } catch (err) {
    // Already expired, already revoked, or the server is unreachable.
    // None of those should stop the sign-out the user just asked for.
    console.warn('[auth] server-side sign-out did not complete:', err)
  } finally {
    localStorage.removeItem(AUTH_TOKEN_KEY)
  }
}
