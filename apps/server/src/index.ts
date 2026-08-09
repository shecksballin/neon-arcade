import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { config } from './config/env'
import quiz from './routes/quiz'
import auth from './routes/auth'
import profile from './routes/profile'

const app = new Hono()

// Middleware — CORS locked to the exact frontend origin (never "*",
// per the security protocol). Configure CLIENT_ORIGIN in Doppler.
app.use('/*', cors({ origin: config.CLIENT_ORIGIN }))

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'neon-arcade-api',
    timestamp: Date.now(),
  })
})

// Auth routes — wallet-signature sign-in → session JWT
app.route('/api/auth', auth)

// Profile routes — username + PIN registration and TOTP enrollment
app.route('/api/profile', profile)

// Quiz routes — AI-generated trivia questions
app.route('/api/quiz', quiz)

// Placeholder: game routes, socket handlers, and database
// connections will be built in Phase 6 using _server_ref/server.ts
// as the reference implementation.

export default {
  port: config.PORT,
  fetch: app.fetch,
}
