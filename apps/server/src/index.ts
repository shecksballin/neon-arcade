import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Server } from 'socket.io'
import { Server as BunEngine, type WebSocketData } from '@socket.io/bun-engine'
import { config } from './config/env'
import quiz from './routes/quiz'
import auth from './routes/auth'
import profile from './routes/profile'
import { attachSocketHandlers } from './socket'

const app = new Hono()

// Middleware — CORS locked to an explicit allowlist (never "*", per the
// security protocol): the CLIENT_ORIGIN origins from Doppler, plus any
// loopback origin so local dev keeps working when Vite hops ports
// (5173 taken → 5174). The callback echoes the request origin only on a
// match; anything else gets no CORS headers and the browser blocks it.
const allowedOrigins = new Set(
  config.CLIENT_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
)
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

/**
 * THE origin predicate — the HTTP API's CORS callback and the socket
 * engine's handshake gate both use this one function, so the allowlist
 * can never drift between the two transports.
 */
export function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.has(origin) || LOOPBACK_ORIGIN.test(origin)
}

app.use(
  '/*',
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
  })
)

// Health check — /ping is an alias for the region-latency pattern: the
// client pings every region's /ping and picks the lowest round trip, so
// the payload includes which region answered.
const healthPayload = () => ({
  status: 'ok',
  service: 'neon-arcade-api',
  region: config.REGION,
  timestamp: Date.now(),
})
app.get('/health', (c) => c.json(healthPayload()))
app.get('/ping', (c) => c.json(healthPayload()))

// Auth routes — wallet-signature sign-in → session JWT
app.route('/api/auth', auth)

// Profile routes — username + PIN registration and TOTP enrollment
app.route('/api/profile', profile)

// Quiz routes — AI-generated trivia questions
app.route('/api/quiz', quiz)

// ---------------------------------------------------------------------------
// Socket.IO on Bun — HTTP API and sockets share port 3002
// ---------------------------------------------------------------------------
// @socket.io/bun-engine replaces the node engine: Bun's fetch/websocket
// handlers below feed it directly, no node:http shim needed. socket.io
// itself never touches HTTP here (io.bind hands it this engine), so CORS
// lives on the ENGINE. Its `origin` option takes strings/regexes — not a
// callback — so it gets the exact same data isAllowedOrigin() checks:
// the allowlisted origins plus the loopback regex. Never '*'.
const io = new Server()

const engine = new BunEngine({
  path: '/socket.io/',
  cors: {
    origin: [...allowedOrigins, LOOPBACK_ORIGIN],
    credentials: true,
  },
  // Belt and braces: CORS headers only steer BROWSERS, so also refuse any
  // handshake whose Origin header fails the shared predicate outright
  // (WebSocket upgrades ignore CORS). Requests without an Origin header
  // (curl, native clients, same-origin) pass through — the JWT middleware
  // still gates them.
  allowRequest: (req) => {
    const origin = req.headers.get('origin')
    return origin && !isAllowedOrigin(origin)
      ? Promise.reject('origin not allowed')
      : Promise.resolve()
  },
})

io.bind(engine)

// Auth middleware, game handlers, /presence namespace, graceful shutdown.
attachSocketHandlers(io)

// handler() supplies Bun.serve pieces: the websocket callbacks, plus an
// idleTimeout (~2× ping interval) — without it Bun's 10s HTTP default
// would kill engine.io long-polling requests mid-poll.
const { websocket, idleTimeout } = engine.handler()

export default {
  port: config.PORT,
  idleTimeout,
  fetch(req: Request, server: Bun.Server<WebSocketData>) {
    const url = new URL(req.url)
    // Engine traffic (polling + upgrade requests) goes to the engine;
    // everything else is the ordinary Hono API, untouched.
    if (url.pathname.startsWith('/socket.io/')) {
      return engine.handleRequest(req, server)
    }
    return app.fetch(req, server)
  },
  websocket,
}
