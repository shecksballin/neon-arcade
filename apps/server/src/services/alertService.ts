/**
 * ALERT SERVICE (WAGERING_IMPLEMENTATION.md §9)
 * =============================================
 * One function, three levels. Structured JSON to stderr is the baseline —
 * Railway captures stderr, so `railway logs | grep '"alert"'` is the
 * monitoring MVP. `critical` additionally attempts email when a provider
 * is wired; today that provider is a stub behind ONE function so Resend
 * can be added later without touching any call site.
 *
 * Mandatory call sites (the spec's list — keep in sync):
 *   - house balance below reserve            payoutService.sendPayout
 *   - payout above threshold                 payoutService.sendPayout
 *   - solvency invariant violation           wagerEngine.settleSlayer
 *   - orphaned settlement created            wagerEngine.settle*
 *   - gift payout failure                    giftService.sendGift
 *   - ≥5 plausibility rejections / 10 min    validation/gameEvents.ts
 */

import { config } from '../config/env'

export type AlertLevel = 'info' | 'warn' | 'critical'

/**
 * Emit an operational alert. Never throws — an alert failure must not take
 * down the money path it is reporting on.
 */
export function alert(level: AlertLevel, subject: string, data: object): void {
  try {
    // Baseline channel: one JSON line on stderr, greppable by shape.
    console.error(
      JSON.stringify({
        alert: level,
        subject,
        at: new Date().toISOString(),
        ...safeData(data),
      })
    )
    if (level === 'critical') void sendCriticalEmail(subject, data)
  } catch {
    // Last resort: even a serialization failure gets SOMETHING to stderr.
    console.error(`[alert:${level}] ${subject} (payload unserializable)`)
  }
}

/** Shallow-copy data defensively; drop anything that fails to serialize. */
function safeData(data: object): object {
  try {
    return JSON.parse(JSON.stringify(data))
  } catch {
    return { note: 'alert data was not serializable' }
  }
}

/**
 * THE provider stub (§9): the single place an email integration plugs in.
 * With ALERT_EMAIL unset (or no provider key wired yet) this is a no-op
 * beyond a breadcrumb — the stderr line above already carries the alert.
 */
async function sendCriticalEmail(subject: string, data: object): Promise<void> {
  if (!config.ALERT_EMAIL) return
  // TODO(resend): POST to the provider here with { to: config.ALERT_EMAIL,
  // subject, body: JSON.stringify(data) }. Keep this the ONLY touch point.
  console.error(
    `[alert:email-stub] would email ${config.ALERT_EMAIL}: ${subject}`
  )
}
