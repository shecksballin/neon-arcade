/**
 * DATABASE CLIENT (Neon Postgres via Drizzle)
 * ===========================================
 * Per the handoff doc: the long-running Railway/Bun server uses the
 * WebSocket `Pool` driver (transactions work); the HTTP driver is only
 * for edge functions. Bun ships a global WebSocket, which the Neon
 * driver picks up via `neonConfig`.
 *
 * DATABASE_URL comes from Doppler. Like JWT_SECRET, it is optional at
 * boot so the rest of the API can run without a database — anything
 * that needs the DB must call `requireDb()` and 503 cleanly when it
 * returns null (config/env.ts explains the pattern).
 */

import { Pool, neonConfig } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-serverless'
import { config } from '../config/env'
import * as schema from './schema'

// Bun has a native WebSocket; hand it to the Neon driver explicitly so
// this also behaves under `bun build --target bun` bundles.
neonConfig.webSocketConstructor = globalThis.WebSocket

// One pool for the whole process. `max` stays modest: Neon's serverless
// Postgres multiplexes fine and this API is low-traffic per instance.
const pool = config.DATABASE_URL
  ? new Pool({ connectionString: config.DATABASE_URL, max: 5 })
  : null

export const db = pool ? drizzle(pool, { schema }) : null

/** The typed database handle, or null when DATABASE_URL isn't set. */
export function requireDb() {
  return db
}
