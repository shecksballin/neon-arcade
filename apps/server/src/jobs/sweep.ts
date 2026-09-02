/**
 * DAILY COLD-WALLET SWEEP (WAGERING_IMPLEMENTATION.md §3.3)
 * =========================================================
 * Moves everything above the float to COLD_WALLET_ADDRESS once a day and
 * records the movement in `payouts` (type 'house_sweep').
 *
 * SCHEDULING DECISION (the spec said ask before adding a dependency): a
 * plain 24h setInterval, NO new dependency. node-cron would buy calendar
 * alignment (e.g. "03:00 UTC") at the cost of a dep; a float sweep does
 * not care what time it runs, only that it runs daily. Swap to cron if
 * the owner wants a fixed hour.
 */

import { config, wageringEnabled } from '../config/env'
import { db } from '../db'
import { payouts } from '../db/schema'
import { alert } from '../services/alertService'
import { sweepToCold } from '../solana/payoutService'

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** The float kept in the hot wallet: reserve + headroom for a day's
 *  payouts. 2× reserve is a starting point the owner can tune. */
function keepFloatSOL(): number {
  return config.HOUSE_MINIMUM_RESERVE_SOL * 2
}

async function runSweep(): Promise<void> {
  try {
    const swept = await sweepToCold(keepFloatSOL())
    if (!swept || !db) return
    await db.insert(payouts).values({
      matchId: null,
      wallet: config.COLD_WALLET_ADDRESS!,
      amountSol: swept.sweptSOL.toFixed(9),
      type: 'house_sweep',
      txSig: swept.txSig,
    })
  } catch (err) {
    // A failed sweep is money SITTING SAFE in the hot wallet — warn, don't
    // page. It will be retried on the next tick.
    alert('warn', 'daily sweep failed', {
      message: err instanceof Error ? err.message : 'unknown',
    })
  }
}

/** Call once at boot (index.ts). No-op unless wagering is configured. */
export function startSweepJob(): void {
  if (!wageringEnabled) return
  // First run after one full interval — booting mid-incident should not
  // immediately drain the hot wallet an operator is topping up.
  setInterval(() => void runSweep(), SWEEP_INTERVAL_MS)
  console.log('[sweep] daily cold-wallet sweep scheduled (24h interval)')
}
