/**
 * SOLANA PAYOUT SERVICE (WAGERING_IMPLEMENTATION.md §3)
 * =====================================================
 * The ONLY file that touches the house wallet's private key (absolute rule
 * §0.4): it is read from config at module init, held in one closure-scoped
 * Keypair, and never logged, serialized, or passed onward. Everything else
 * in the server asks THIS module to move SOL.
 *
 * Network comes from SOLANA_RPC_URL (devnet until the owner says otherwise
 * — never hardcode a cluster). When wagering is not configured
 * (config.wageringEnabled false) every export throws a clear error; routes
 * gate on wageringEnabled first and 503, so those throws are a programming
 * -error tripwire, not a user-facing path.
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { config, wageringEnabled } from '../config/env'
import { alert } from '../services/alertService'

/** Deposit amount tolerance (§3.2): one signature fee of slack. */
const AMOUNT_TOLERANCE_SOL = 0.000005

// ─────────────────────────────────────────────────
// Module init — connection + keypair, once.
// ─────────────────────────────────────────────────

interface SolanaCtx {
  connection: Connection
  houseKeypair: Keypair
  housePubkey: PublicKey
  coldPubkey: PublicKey
}

/**
 * Lazily built so a server WITHOUT wagering config can import this module
 * (routes/index wiring) without exploding at boot. The first actual money
 * call builds it; a bad key crashes THAT call with a clear message.
 */
let ctx: SolanaCtx | null = null
function requireCtx(): SolanaCtx {
  if (!wageringEnabled) {
    throw new Error('wagering is not configured on this server')
  }
  if (ctx) return ctx

  // The key is a JSON array string (solana-keygen id.json contents).
  // Parse errors are rethrown WITHOUT the input — no key material in logs.
  let secret: Uint8Array
  try {
    secret = Uint8Array.from(JSON.parse(config.HOUSE_WALLET_PRIVATE_KEY!))
  } catch {
    throw new Error(
      'HOUSE_WALLET_PRIVATE_KEY is not a valid JSON byte array — fix it in Doppler'
    )
  }
  const houseKeypair = Keypair.fromSecretKey(secret)
  const housePubkey = new PublicKey(config.HOUSE_WALLET_ADDRESS!)
  if (!houseKeypair.publicKey.equals(housePubkey)) {
    // A mismatched key/address pair would verify deposits against one
    // wallet and sign payouts from another — refuse everything.
    throw new Error(
      'HOUSE_WALLET_PRIVATE_KEY does not match HOUSE_WALLET_ADDRESS'
    )
  }

  ctx = {
    connection: new Connection(config.SOLANA_RPC_URL!, 'confirmed'),
    houseKeypair,
    housePubkey,
    coldPubkey: new PublicKey(config.COLD_WALLET_ADDRESS!),
  }
  return ctx
}

/** Lamport-exact conversion (§3.1): floor, never fractional lamports. */
function toLamports(amountSOL: number): number {
  return Math.floor(amountSOL * LAMPORTS_PER_SOL)
}

// ─────────────────────────────────────────────────
// §3.3 getHouseBalance
// ─────────────────────────────────────────────────

/** Current house wallet balance in SOL. */
export async function getHouseBalance(): Promise<number> {
  const { connection, housePubkey } = requireCtx()
  const lamports = await connection.getBalance(housePubkey, 'confirmed')
  return lamports / LAMPORTS_PER_SOL
}

// ─────────────────────────────────────────────────
// §3.1 sendPayout
// ─────────────────────────────────────────────────

/**
 * Send SOL from the house wallet. Returns the transaction signature.
 *
 * Guards, in order:
 *  1. RESERVE — if paying would drop the house below
 *     HOUSE_MINIMUM_RESERVE_SOL, alert critical and THROW. Never send.
 *  2. LARGE PAYOUT — above PAYOUT_ALERT_THRESHOLD_SOL, alert (proceed).
 *
 * The caller owns the DB consequences of a throw (§7.6: no auto-retry —
 * a thrown send may or may not have reached the chain).
 */
export async function sendPayout(
  toWallet: string,
  amountSOL: number
): Promise<string> {
  const { connection, houseKeypair, housePubkey } = requireCtx()
  if (!Number.isFinite(amountSOL) || amountSOL <= 0) {
    throw new Error(`refusing payout of non-positive amount ${amountSOL}`)
  }

  const balance = await getHouseBalance()
  if (balance - amountSOL < config.HOUSE_MINIMUM_RESERVE_SOL) {
    alert('critical', 'house balance below reserve — payout refused', {
      balance,
      requested: amountSOL,
      reserve: config.HOUSE_MINIMUM_RESERVE_SOL,
      toWallet,
    })
    throw new Error('house balance below minimum reserve — payout refused')
  }

  if (amountSOL > config.PAYOUT_ALERT_THRESHOLD_SOL) {
    alert('warn', 'large payout', { amount: amountSOL, toWallet })
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: housePubkey,
      toPubkey: new PublicKey(toWallet),
      lamports: toLamports(amountSOL),
    })
  )

  try {
    return await sendAndConfirmTransaction(connection, tx, [houseKeypair], {
      commitment: 'confirmed',
    })
  } catch (err) {
    // Re-throw with a log-safe message: RPC errors can embed the whole
    // serialized transaction; the signature bytes must never hit a log.
    const msg = err instanceof Error ? err.message.slice(0, 300) : 'unknown'
    throw new Error(`sendPayout failed (${amountSOL} SOL → ${toWallet}): ${msg}`)
  }
}

// ─────────────────────────────────────────────────
// §3.2 verifyDeposit
// ─────────────────────────────────────────────────

/**
 * Prove that `txSignature` is a real, recent, successful transfer of at
 * least `expectedAmountSOL` from `expectedSender` INTO the house wallet.
 * Resolves `true` or throws with the specific failure — callers surface
 * the message; nothing here credits anything.
 */
export async function verifyDeposit(opts: {
  txSignature: string
  expectedSender: string
  expectedAmountSOL: number
  maxAgeSeconds?: number
}): Promise<true> {
  const { connection, housePubkey } = requireCtx()
  const maxAge = opts.maxAgeSeconds ?? 120

  // Indexing lag: a just-confirmed tx can take a few seconds to appear in
  // getParsedTransaction. Retry up to 10× at 2s (§3.2), then give up.
  let tx = null
  for (let attempt = 0; attempt < 10; attempt++) {
    tx = await connection.getParsedTransaction(opts.txSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    if (tx) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!tx) throw new Error('deposit transaction not found on chain')

  if (tx.meta?.err) throw new Error('deposit transaction failed on chain')

  if (!tx.blockTime || Date.now() / 1000 - tx.blockTime > maxAge) {
    // Old signatures are refused so a long-forgotten (but never-credited)
    // transfer can't be dug up and replayed after a DB restore.
    throw new Error('deposit transaction is too old')
  }

  const keys = tx.transaction.message.accountKeys
  // Fee payer is account 0 — the wallet that SIGNED and funded the tx.
  if (keys[0]?.pubkey.toBase58() !== opts.expectedSender) {
    throw new Error('deposit was not sent by the authenticated wallet')
  }

  // Received = house wallet's post − pre balance, at its account index.
  const houseIndex = keys.findIndex((k) =>
    k.pubkey.equals(housePubkey)
  )
  if (houseIndex === -1) {
    throw new Error('deposit transaction does not touch the house wallet')
  }
  const pre = tx.meta?.preBalances?.[houseIndex]
  const post = tx.meta?.postBalances?.[houseIndex]
  if (pre === undefined || post === undefined) {
    throw new Error('deposit transaction has no balance metadata')
  }
  const receivedSOL = (post - pre) / LAMPORTS_PER_SOL
  if (receivedSOL < opts.expectedAmountSOL - AMOUNT_TOLERANCE_SOL) {
    throw new Error(
      `deposit amount mismatch: received ${receivedSOL}, expected ${opts.expectedAmountSOL}`
    )
  }

  return true
}

// ─────────────────────────────────────────────────
// §3.3 sweepToCold
// ─────────────────────────────────────────────────

/**
 * Move everything above `keepFloatSOL` to the cold wallet. Returns the
 * amount swept (0 = nothing worth sweeping). The caller (jobs/sweep.ts)
 * records the payouts row — this module stays DB-free.
 */
export async function sweepToCold(
  keepFloatSOL: number
): Promise<{ sweptSOL: number; txSig: string } | null> {
  const { connection, houseKeypair, housePubkey, coldPubkey } = requireCtx()

  const balance = await getHouseBalance()
  const excess = balance - keepFloatSOL
  if (excess <= 0.01) return null // dust isn't worth a signature fee

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: housePubkey,
      toPubkey: coldPubkey,
      lamports: toLamports(excess),
    })
  )
  const txSig = await sendAndConfirmTransaction(connection, tx, [houseKeypair], {
    commitment: 'confirmed',
  })
  alert('info', 'house sweep to cold wallet', { sweptSOL: excess, txSig })
  return { sweptSOL: excess, txSig }
}
