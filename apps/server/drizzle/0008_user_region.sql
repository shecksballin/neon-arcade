-- Idempotent (same convention as 0007): safe to re-run.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "region" text;