CREATE TABLE "elo_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid,
	"wallet" text NOT NULL,
	"game_key" text NOT NULL,
	"mode" text NOT NULL,
	"elo_before" integer NOT NULL,
	"elo_after" integer NOT NULL,
	"elo_change" integer NOT NULL,
	"kills" integer DEFAULT 0,
	"placement" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"deposit_sol" numeric(18, 9) DEFAULT '0' NOT NULL,
	"current_pot" numeric(18, 9) DEFAULT '0' NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"eliminated_by" text,
	"auto_cash_out_sol" numeric(18, 9),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" text NOT NULL,
	"mode" text NOT NULL,
	"game_mode" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"total_pot" numeric(18, 9) DEFAULT '0',
	"house_total" numeric(18, 9) DEFAULT '0',
	"winner" text,
	"bet_amount" numeric(18, 9) DEFAULT '0',
	"region" text DEFAULT 'local',
	"min_players" integer DEFAULT 2,
	"max_players" integer DEFAULT 2,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"amount_sol" numeric(18, 9) NOT NULL,
	"type" text NOT NULL,
	"tx_sig" text,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_tx_sig_unique" UNIQUE("tx_sig")
);
--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_session_per_wallet" ON "match_players" USING btree ("wallet") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "match_players_match_status_idx" ON "match_players" USING btree ("match_id","status");