CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"username" text,
	"pin_hash" text,
	"totp_secret" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"elo" integer DEFAULT 0 NOT NULL,
	"elo_ffa" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_wallet_unique" UNIQUE("wallet")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_unique" ON "users" USING btree (lower("username"));