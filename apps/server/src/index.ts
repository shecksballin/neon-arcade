import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()

// Middleware
app.use('/*', cors())

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'neon-arcade-api',
    timestamp: Date.now(),
  })
})

// Placeholder: game routes, socket handlers, and database
// connections will be built in Phase 6 using _server_ref/server.ts
// as the reference implementation.

export default {
  port: 3001,
  fetch: app.fetch,
}
