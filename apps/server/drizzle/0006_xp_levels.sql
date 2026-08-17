-- XP + LEVELS (progression layer — see @neon/types/xp.ts for the curve)
--
-- `users.xp` is the career counter every level in the app is derived from.
-- It is monotonic and season-proof: rolloverSeason() resets RP, never this.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "xp" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Append-only ledger of every award: powers the "+150 XP" read-out, the daily
-- cap on self-reported single-player results, and the audit trail.
CREATE TABLE IF NOT EXISTS "xp_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"match_id" uuid,
	"game_key" text NOT NULL,
	"mode" text NOT NULL,
	"amount" integer NOT NULL,
	"source" text DEFAULT 'match' NOT NULL,
	"breakdown" text,
	"xp_before" integer NOT NULL,
	"xp_after" integer NOT NULL,
	"level_before" integer NOT NULL,
	"level_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xp_events_wallet_created_idx" ON "xp_events" USING btree ("wallet","created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xp_events_wallet_source_idx" ON "xp_events" USING btree ("wallet","source","created_at" DESC);
