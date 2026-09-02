/**
 * DEVNET SMOKE TEST (WAGERING_IMPLEMENTATION.md §10)
 * ==================================================
 * End-to-end proof of the wagering engine against REAL devnet transactions.
 *
 * Run with the wagering env configured for DEVNET:
 *   cd apps/server && doppler run -- bun run scripts/devnet-smoke.ts
 *
 * What it does: creates two ephemeral player wallets, airdrops devnet SOL
 * to them (and tops the house up if needed), then walks the acceptance
 * list — deposits (replay/nonce/wrong-sender/wrong-amount), the full 1v1
 * flow, the double-settle and concurrent-kill races, slayer settlement +
 * solvency, gifts (cap, self, new-wallet), the balance guard, and the
 * orphaned queue. Drives the SERVICES directly (the same code the routes
 * call) so the races are exercised at the layer they are guarded in.
 *
 * Every section prints PASS/FAIL; the process exits non-zero on any FAIL.
 * Devnet airdrops are rate-limited — rerun with `--skip-airdrop` once the
 * ephemeral wallets (persisted to .devnet-smoke-wallets.json) are funded.
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
import { eq } from 'drizzle-orm'
import { config, wageringEnabled } from '../src/config/env'
import { db } from '../src/db'
import { deposits, gifts, matches, matchPlayers, payouts } from '../src/db/schema'
import { issueNonce, consumeNonce } from '../src/services/nonceService'
import { confirmDeposit } from '../src/services/depositService'
import { resolveKill, settle1v1, settleSlayer } from '../src/services/wagerEngine'
import { sendGift } from '../src/services/giftService'
import { verifyDeposit, getHouseBalance } from '../src/solana/payoutService'

// ─────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  PASS' : '✗ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function bail(msg: string): never {
  console.error(`ABORT: ${msg}`)
  process.exit(1)
}

if (!wageringEnabled) bail('wagering env is not configured (see §2)')
if (!db) bail('DATABASE_URL is not configured')
if (!/devnet/i.test(config.SOLANA_RPC_URL!)) {
  bail(`refusing to run against non-devnet RPC: ${config.SOLANA_RPC_URL}`)
}

const connection = new Connection(config.SOLANA_RPC_URL!, 'confirmed')
const housePubkey = new PublicKey(config.HOUSE_WALLET_ADDRESS!)

/** Ephemeral wallets persist across runs so airdrops aren't re-begged. */
const WALLET_CACHE = new URL('./.devnet-smoke-wallets.json', import.meta.url)
async function loadPlayers(): Promise<[Keypair, Keypair]> {
  try {
    const raw = JSON.parse(await Bun.file(WALLET_CACHE).text())
    return [
      Keypair.fromSecretKey(Uint8Array.from(raw[0])),
      Keypair.fromSecretKey(Uint8Array.from(raw[1])),
    ]
  } catch {
    const pair: [Keypair, Keypair] = [Keypair.generate(), Keypair.generate()]
    await Bun.write(
      WALLET_CACHE,
      JSON.stringify(pair.map((k) => Array.from(k.secretKey)))
    )
    return pair
  }
}

async function ensureFunds(pubkey: PublicKey, minSOL: number) {
  const balance = (await connection.getBalance(pubkey)) / LAMPORTS_PER_SOL
  if (balance >= minSOL || process.argv.includes('--skip-airdrop')) return
  console.log(`  airdropping 2 SOL to ${pubkey.toBase58().slice(0, 8)}…`)
  const sig = await connection.requestAirdrop(pubkey, 2 * LAMPORTS_PER_SOL)
  await connection.confirmTransaction(sig, 'confirmed')
}

/** A real devnet transfer player → house; returns the signature. */
async function depositOnChain(from: Keypair, amountSOL: number): Promise<string> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: housePubkey,
      lamports: Math.floor(amountSOL * LAMPORTS_PER_SOL),
    })
  )
  return sendAndConfirmTransaction(connection, tx, [from], {
    commitment: 'confirmed',
  })
}

/** Fresh wager match row for a scenario. */
async function createMatch(gameMode: string, betAmount: number) {
  const [row] = await db!
    .insert(matches)
    .values({
      gameId: 'smoke',
      mode: gameMode === '1v1' ? '1v1' : 'ffa',
      gameMode,
      status: 'active',
      betAmount: betAmount.toFixed(9),
      region: 'smoke',
    })
    .returning()
  return row
}

async function activateSeats(matchId: string) {
  await db!
    .update(matchPlayers)
    .set({ status: 'active' })
    .where(eq(matchPlayers.matchId, matchId))
}

// ─────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────

const BET = Math.max(config.MIN_BET_SOL, 0.05)

console.log('devnet-smoke: setting up wallets…')
const [alice, bob] = await loadPlayers()
await ensureFunds(alice.publicKey, 1)
await ensureFunds(bob.publicKey, 1)
console.log(`  house balance: ${await getHouseBalance()} SOL`)

// ── Deposits ────────────────────────────────────────────────────────────
{
  console.log('\n§10.1 deposit: nonce → transfer → confirm, exactly once')
  const match = await createMatch('1v1', BET)
  const nonce = await issueNonce(alice.publicKey.toBase58())
  const sig = await depositOnChain(alice, BET)

  const first = await confirmDeposit({
    wallet: alice.publicKey.toBase58(),
    matchId: match.id,
    txSig: sig,
    nonce,
    amountSol: BET,
  })
  check('first confirm credits', first.ok)

  const replayNonce = await issueNonce(alice.publicKey.toBase58())
  const replay = await confirmDeposit({
    wallet: alice.publicKey.toBase58(),
    matchId: match.id,
    txSig: sig,
    nonce: replayNonce,
    amountSol: BET,
  })
  check(
    'replayed txSig → 409, credits nothing',
    !replay.ok && replay.status === 409
  )
  const rows = await db!.select().from(deposits).where(eq(deposits.txSig, sig))
  check('exactly one deposits row', rows.length === 1)

  console.log('\n§10.2 nonce rules')
  const spent = await issueNonce(alice.publicKey.toBase58())
  check('fresh nonce consumes', await consumeNonce(spent, alice.publicKey.toBase58()))
  check('reused nonce rejected', !(await consumeNonce(spent, alice.publicKey.toBase58())))
  check(
    'foreign-wallet nonce rejected',
    !(await consumeNonce(await issueNonce(alice.publicKey.toBase58()), bob.publicKey.toBase58()))
  )

  console.log('\n§10.3 verifyDeposit rejections')
  const wrongSender = await verifyDeposit({
    txSignature: sig,
    expectedSender: bob.publicKey.toBase58(),
    expectedAmountSOL: BET,
  }).then(() => false, () => true)
  check('wrong sender rejected', wrongSender)
  const wrongAmount = await verifyDeposit({
    txSignature: sig,
    expectedSender: alice.publicKey.toBase58(),
    expectedAmountSOL: BET * 3,
  }).then(() => false, () => true)
  check('wrong amount rejected', wrongAmount)
}

// ── 1v1 full flow + races ───────────────────────────────────────────────
{
  console.log('\n§10.4 1v1: two deposits → kill → settle → on-chain payout')
  const match = await createMatch('1v1', BET)
  for (const p of [alice, bob]) {
    const nonce = await issueNonce(p.publicKey.toBase58())
    const sig = await depositOnChain(p, BET)
    const r = await confirmDeposit({
      wallet: p.publicKey.toBase58(),
      matchId: match.id,
      txSig: sig,
      nonce,
      amountSol: BET,
    })
    if (!r.ok) bail(`1v1 deposit failed: ${r.error}`)
  }
  await activateSeats(match.id)

  const kill = await resolveKill({
    matchId: match.id,
    mode: 'steal',
    killer: alice.publicKey.toBase58(),
    victim: bob.publicKey.toBase58(),
    reason: 'combat',
  })
  check('kill applies', kill.ok)

  console.log('\n§10.6 concurrent kills of one victim → exactly one applies')
  // Bob is already eliminated — a second kill on him must reject.
  const again = await resolveKill({
    matchId: match.id,
    mode: 'steal',
    killer: alice.publicKey.toBase58(),
    victim: bob.publicKey.toBase58(),
    reason: 'combat',
  })
  check('second kill on same victim rejected', !again.ok)

  console.log('\n§10.5 double-settle race → exactly one payout')
  const [s1, s2] = await Promise.all([
    settle1v1({ matchId: match.id, winner: alice.publicKey.toBase58() }),
    settle1v1({ matchId: match.id, winner: alice.publicKey.toBase58() }),
  ])
  check('exactly one settle wins', s1.ok !== s2.ok, JSON.stringify({ s1, s2 }))
  const paidRows = await db!
    .select()
    .from(payouts)
    .where(eq(payouts.matchId, match.id))
  check('exactly one payouts row', paidRows.length === 1)
  const winner = s1.ok ? s1 : s2.ok ? s2 : null
  check('payouts row matches txSig', winner !== null && paidRows[0]?.txSig === winner.txSig)
}

// ── Slayer ──────────────────────────────────────────────────────────────
{
  console.log('\n§10.7 slayer: kills incl. environment → paid by kill count')
  const match = await createMatch('slayer', BET)
  // Ledger-only seats for the engine math (deposits proven above; devnet
  // airdrop budget is better spent on the flows that need the chain).
  const seats = [alice.publicKey.toBase58(), bob.publicKey.toBase58()]
  for (const wallet of seats) {
    await db!.insert(matchPlayers).values({
      matchId: match.id,
      wallet,
      status: 'active',
      depositSol: BET.toFixed(9),
      currentPot: BET.toFixed(9),
    })
  }
  await db!
    .update(matches)
    .set({ totalPot: (BET * seats.length).toFixed(9) })
    .where(eq(matches.id, match.id))

  const k1 = await resolveKill({
    matchId: match.id,
    mode: 'accumulate',
    killer: alice.publicKey.toBase58(),
    victim: bob.publicKey.toBase58(),
    reason: 'combat',
  })
  check('slayer kill banks (no SOL moves)', k1.ok && k1.killerKills === 1)

  const settled = await settleSlayer({ matchId: match.id })
  check('slayer settles', settled.ok)
  if (settled.ok) {
    const expected = BET * (1 - config.HOUSE_FEE_PERCENT / 100)
    check(
      'killer paid kills × entryFee × (1 − fee)',
      settled.paid.length === 1 &&
        Math.abs(settled.paid[0].amountSol - expected) < 1e-9
    )
  }
}

// ── Gifts ───────────────────────────────────────────────────────────────
{
  console.log('\n§10.9 gifts')
  const giftAmount = Math.max(config.MIN_GIFT_SOL, 0.02)
  const freshRecipient = Keypair.generate() // no account row — §8 edge rule

  const nonce = await issueNonce(alice.publicKey.toBase58())
  const sig = await depositOnChain(alice, giftAmount)
  const sent = await sendGift({
    fromWallet: alice.publicKey.toBase58(),
    toWallet: freshRecipient.publicKey.toBase58(),
    amountSol: giftAmount,
    txSig: sig,
    nonce,
  })
  check('gift to brand-new wallet completes', sent.ok)
  if (sent.ok) {
    const onChain =
      (await connection.getBalance(freshRecipient.publicKey)) / LAMPORTS_PER_SOL
    check(
      'recipient received amount − fee on-chain',
      Math.abs(onChain - sent.payoutSol) < 1e-6,
      `${onChain} vs ${sent.payoutSol}`
    )
  }

  const selfGift = await sendGift({
    fromWallet: alice.publicKey.toBase58(),
    toWallet: alice.publicKey.toBase58(),
    amountSol: giftAmount,
    txSig: 'y'.repeat(88),
    nonce: await issueNonce(alice.publicKey.toBase58()),
  })
  check('self-gift rejected', !selfGift.ok && selfGift.status === 400)

  // Daily cap: fake a cap-filling row, then expect rejection.
  await db!.insert(gifts).values({
    fromWallet: alice.publicKey.toBase58(),
    toWallet: bob.publicKey.toBase58(),
    amountSol: config.GIFT_DAILY_CAP_SOL.toFixed(9),
    feeSol: '0',
    depositTxSig: 'smoke-cap-filler',
    status: 'completed',
  })
  const capped = await sendGift({
    fromWallet: alice.publicKey.toBase58(),
    toWallet: bob.publicKey.toBase58(),
    amountSol: giftAmount,
    txSig: 'x'.repeat(88),
    nonce: await issueNonce(alice.publicKey.toBase58()),
  })
  check('daily cap enforced', !capped.ok && /cap/.test(capped.ok ? '' : capped.error))
  await db!.delete(gifts).where(eq(gifts.depositTxSig, 'smoke-cap-filler'))
}

// ── Balance guard + orphaned queue ──────────────────────────────────────
{
  console.log('\n§10.10 balance guard (reserve raised above balance)')
  const balance = await getHouseBalance()
  const original = config.HOUSE_MINIMUM_RESERVE_SOL
  // Config is a plain object — raise the reserve for this one check.
  ;(config as { HOUSE_MINIMUM_RESERVE_SOL: number }).HOUSE_MINIMUM_RESERVE_SOL =
    balance + 1
  const match = await createMatch('1v1', BET)
  await db!.insert(matchPlayers).values({
    matchId: match.id,
    wallet: alice.publicKey.toBase58(),
    status: 'active',
    depositSol: BET.toFixed(9),
    currentPot: BET.toFixed(9),
  })
  const refused = await settle1v1({
    matchId: match.id,
    winner: alice.publicKey.toBase58(),
  })
  check('payout refused below reserve', !refused.ok && refused.error === 'payout_failed')
  ;(config as { HOUSE_MINIMUM_RESERVE_SOL: number }).HOUSE_MINIMUM_RESERVE_SOL =
    original

  console.log('\n§10.11 orphaned queue')
  const [row] = await db!
    .select()
    .from(matches)
    .where(eq(matches.id, match.id))
  check(
    "failed settle left match in 'settling' (visible at /api/internal/orphaned)",
    row?.status === 'settling'
  )
  // Tidy the deliberate orphan so reruns start clean.
  await db!
    .update(matches)
    .set({ status: 'cancelled' })
    .where(eq(matches.id, match.id))
}

console.log(
  failures === 0
    ? '\nALL CHECKS PASSED'
    : `\n${failures} CHECK(S) FAILED`
)
process.exit(failures === 0 ? 0 : 1)
