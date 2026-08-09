/**
 * drizzle-kit config — schema push/introspection against Neon.
 * Run through Doppler so DATABASE_URL exists:
 *   doppler run -- bun run db:push
 */
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
