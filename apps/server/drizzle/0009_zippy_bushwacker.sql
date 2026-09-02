CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid,
	"wallet" text NOT NULL,
	"amount_sol" numeric(18, 9) NOT NULL,
	"tx_sig" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposits_tx_sig_unique" UNIQUE("tx_sig")
);
--> statement-breakpoint
CREATE TABLE "gifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_wallet" text NOT NULL,
	"to_wallet" text NOT NULL,
	"amount_sol" numeric(18, 9) NOT NULL,
	"fee_sol" numeric(18, 9) NOT NULL,
	"deposit_tx_sig" text NOT NULL,
	"payout_tx_sig" text,
	"status" text DEFAULT 'completed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "match_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "eliminated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "placement" integer;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "settle_tx_sig" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "deposits_wallet_created_idx" ON "deposits" USING btree ("wallet","created_at" desc);--> statement-breakpoint
CREATE INDEX "gifts_from_created_idx" ON "gifts" USING btree ("from_wallet","created_at" desc);--> statement-breakpoint
CREATE INDEX "gifts_to_created_idx" ON "gifts" USING btree ("to_wallet","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "one_live_seat_per_match" ON "match_players" USING btree ("match_id","wallet") WHERE status IN ('deposited', 'active');