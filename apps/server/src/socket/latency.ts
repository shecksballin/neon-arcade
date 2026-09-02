import type { Server, Socket } from 'socket.io'

/**
 * latency:ping — the in-match RTT probe behind the client's PerfHud
 * (apps/web/src/components/common/PerfHud.tsx).
 *
 * An ack echo, deliberately: the client times its own emit → ack round trip,
 * so the server holds no state and answers with nothing — an ack-shaped
 * handler is the whole implementation. (House convention elsewhere is
 * answer-by-emit, but an emit reply would need client-side request/response
 * matching to compute RTT; the ack IS that matching.) It rides the
 * established authed socket, so it measures the same transport gameplay
 * uses — including fly-replay region routing. Stateless, so no disconnect
 * cleanup, per the module contract in ./index.ts.
 */
export function registerLatency(_io: Server, socket: Socket): void {
  socket.on('latency:ping', (ack: unknown) => {
    // No callback (or a malformed frame where the ack slot isn't a
    // function) — nothing to answer; silently ignore, as everywhere else.
    if (typeof ack !== 'function') return
    ack()
  })
}
