CREATE TABLE "friends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_wallet" text NOT NULL,
	"recipient_wallet" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid,
	"wallet" text NOT NULL,
	"game_key" text NOT NULL,
	"mode" text NOT NULL,
	"result" text NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"deaths" integer DEFAULT 0 NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"placement" integer,
	"opponent_username" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_wallet" text NOT NULL,
	"to_wallet" text NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"body" text,
	"data" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "friends_pair_unique" ON "friends" USING btree ("requester_wallet","recipient_wallet");--> statement-breakpoint
CREATE INDEX "friends_recipient_status_idx" ON "friends" USING btree ("recipient_wallet","status");--> statement-breakpoint
CREATE INDEX "match_results_wallet_game_idx" ON "match_results" USING btree ("wallet","game_key");--> statement-breakpoint
CREATE INDEX "match_results_wallet_created_idx" ON "match_results" USING btree ("wallet","created_at" desc);--> statement-breakpoint
CREATE INDEX "match_results_game_idx" ON "match_results" USING btree ("game_key");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("from_wallet","to_wallet","created_at");--> statement-breakpoint
CREATE INDEX "messages_to_read_idx" ON "messages" USING btree ("to_wallet","read_at");--> statement-breakpoint
CREATE INDEX "notifications_wallet_read_idx" ON "notifications" USING btree ("wallet","read_at");