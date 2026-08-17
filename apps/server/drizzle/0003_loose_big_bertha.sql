ALTER TABLE "elo_history" ADD COLUMN "ladder" text;--> statement-breakpoint
ALTER TABLE "elo_history" ADD COLUMN "result" text;--> statement-breakpoint
ALTER TABLE "elo_history" ADD COLUMN "rp_before" integer;--> statement-breakpoint
ALTER TABLE "elo_history" ADD COLUMN "rp_after" integer;--> statement-breakpoint
ALTER TABLE "elo_history" ADD COLUMN "rp_change" integer;--> statement-breakpoint
ALTER TABLE "elo_history" ADD COLUMN "mu_before" double precision;--> statement-breakpoint
ALTER TABLE "elo_history" ADD COLUMN "mu_after" double precision;--> statement-breakpoint
ALTER TABLE "elo_history" ADD COLUMN "sigma_before" double precision;--> statement-breakpoint
ALTER TABLE "elo_history" ADD COLUMN "sigma_after" double precision;--> statement-breakpoint
ALTER TABLE "elo_history" ADD COLUMN "shielded" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "elo_history" ADD COLUMN "season" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mu_1v1" double precision DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sigma_1v1" double precision DEFAULT 8.333333333333334 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "rp_1v1" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mu_ffa" double precision DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sigma_ffa" double precision DEFAULT 8.333333333333334 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "rp_ffa" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "season" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "elo_history_wallet_created_idx" ON "elo_history" USING btree ("wallet","created_at" desc);--> statement-breakpoint
-- ── HAND-ADDED BACKFILL (Ranked 2.0) ─────────────────────────────────────
-- `elo` / `elo_ffa` are now a MIRROR of the RP columns (rankService writes
-- both on every settle). Seed them here so rows that existed before this
-- migration agree with the new ladder immediately, instead of a legacy
-- reader showing a stale 0 next to a real RP of 1000. Safe to re-run.
UPDATE "users" SET "elo" = "rp_1v1", "elo_ffa" = "rp_ffa";