/**
 * SOLANA (client-side, read-only)
 * ===============================
 * A tiny @solana/kit RPC client used by the wallet UI to READ on-chain
 * state — right now just the SOL balance shown in the wallet panel.
 *
 * Keep this devnet while testing; it must match the cluster the Privy
 * provider talks to (AppPrivyProvider). No keys, no signing, no writes
 * happen here — all money movement lives on the server per the security
 * protocol. This is display only.
 */

import { address, createSolanaRpc } from '@solana/kit'

export const SOLANA_CLUSTER = 'devnet'
export const SOLANA_RPC_URL = 'https://api.devnet.solana.com'

// A block explorer link for an address on the current cluster
export function explorerAddressUrl(walletAddress: string): string {
  return `https://explorer.solana.com/address/${walletAddress}?cluster=${SOLANA_CLUSTER}`
}

// One shared client — createSolanaRpc just wires up a transport; no
// network request happens until .send() is called.
const rpc = createSolanaRpc(SOLANA_RPC_URL)

/** Current balance of a wallet, in SOL (lamports ÷ 1e9). */
export async function getSolBalance(walletAddress: string): Promise<number> {
  const { value: lamports } = await rpc.getBalance(address(walletAddress)).send()
  return Number(lamports) / 1_000_000_000
}
