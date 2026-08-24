-- NOTE: xp_events / users.xp were applied out-of-band (apply_0006.ts) before
-- this file was generated, so every statement is IF NOT EXISTS — the file is
-- safe to run against a database that already has them.
CREATE TABLE IF NOT EXISTS "community_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_wallet" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"game_key" text,
	"mode" text,
	"room_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "xp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "community_posts_feed_idx" ON "community_posts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "community_posts_author_idx" ON "community_posts" USING btree ("author_wallet","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xp_events_wallet_created_idx" ON "xp_events" USING btree ("wallet","created_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xp_events_wallet_source_idx" ON "xp_events" USING btree ("wallet","source","created_at" desc);