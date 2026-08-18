/**
 * SOLANA (client-side, read-only)
 * ===============================
 * A tiny @solana/kit RPC client used by the wallet UI to READ on-chain
 * state — right now just the SOL balance shown in the wallet panel.
 *
 * Keep this devnet while testing; it must match the cluster the Privy
 * provider talks to (auth/privyRuntime.tsx). No keys, no signing, no writes
 * happen here — all money movement lives on the server per the security
 * protocol. This is display only.
 *
 * ‼️ @solana/kit IS IMPORTED DYNAMICALLY, AND MUST STAY THAT WAY.
 * -------------------------------------------------------------
 * The SDK is a 37 kB gzip chunk. This module's other exports are a string,
 * a URL and a string-template function — and SidebarMenu (which mounts on
 * the LANDING PAGE) imports one of those strings. With a static
 * `import { createSolanaRpc } from '@solana/kit'` at the top of this file,
 * that single constant pulled the whole RPC client onto the landing page of
 * every visitor, signed in or not, to render the word "devnet".
 *
 * Nothing here needs the SDK until someone actually asks for a balance, so
 * the import lives inside `getSolBalance`. This is the same reasoning that
 * put `bs58` behind a dynamic import in hooks/useBackendAuth.ts. If you add
 * an export to this file, keep it SDK-free — or put it somewhere else.
 */

export const SOLANA_CLUSTER = 'devnet'
export const SOLANA_RPC_URL = 'https://api.devnet.solana.com'

// A block explorer link for an address on the current cluster
export function explorerAddressUrl(walletAddress: string): string {
  return `https://explorer.solana.com/address/${walletAddress}?cluster=${SOLANA_CLUSTER}`
}

/**
 * The RPC client, created on first use and reused after that.
 *
 * Held as the PROMISE rather than the resolved client so two concurrent
 * callers share one dynamic import instead of racing to start two. The
 * client itself only wires up a transport; no network request happens until
 * `.send()` is called.
 */
let rpcPromise: Promise<{
  rpc: import('@solana/kit').Rpc<import('@solana/kit').SolanaRpcApi>
  address: typeof import('@solana/kit').address
}> | null = null

function loadRpc() {
  if (!rpcPromise) {
    rpcPromise = import('@solana/kit').then(({ address, createSolanaRpc }) => ({
      rpc: createSolanaRpc(SOLANA_RPC_URL),
      address,
    }))
    // DO NOT CACHE A FAILURE. A dynamic import rejects on any network hiccup
    // — a dropped connection, or a deploy that replaced this hashed chunk
    // while the tab was open. Keeping the rejected promise would make the
    // balance permanently unreadable for the life of the page, and the wallet
    // panel's refresh button would visibly do nothing forever. Clearing the
    // cache lets the next call (i.e. that button) try again.
    rpcPromise.catch(() => {
      rpcPromise = null
    })
  }
  return rpcPromise
}

/** Current balance of a wallet, in SOL (lamports ÷ 1e9). */
export async function getSolBalance(walletAddress: string): Promise<number> {
  const { rpc, address } = await loadRpc()
  const { value: lamports } = await rpc.getBalance(address(walletAddress)).send()
  return Number(lamports) / 1_000_000_000
}
