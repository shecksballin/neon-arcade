// ─────────────────────────────────────────
// AUTH — wallet sign-in message
// ─────────────────────────────────────────
// The client signs this exact string with the user's Solana wallet
// (Privy embedded or external) and the server verifies the ed25519
// signature over the exact same bytes. It lives here, shared by both
// sides, so the two can never drift apart — a one-character mismatch
// would make every signature verification fail.

export const SIGN_IN_MESSAGE_TITLE = 'Sign in to Neon Arcade'

/** Builds the plaintext message a wallet signs to prove ownership. */
export function buildSignInMessage(nonce: string): string {
  return `${SIGN_IN_MESSAGE_TITLE}\nNonce: ${nonce}`
}
