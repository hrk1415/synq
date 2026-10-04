CREATE TABLE "email_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"wallet_address" text,
	"name" text,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_email_verifications_wallet_lower" CHECK (wallet_address IS NULL OR wallet_address = LOWER(wallet_address))
);
--> statement-breakpoint
CREATE TABLE "milestone_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_address" text NOT NULL,
	"milestone_id" integer NOT NULL,
	"completion_pct" integer NOT NULL,
	"summary" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"notes" text,
	"recommendation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_milestone_verifications_deal_lower" CHECK (deal_address = LOWER(deal_address))
);
--> statement-breakpoint
CREATE INDEX "idx_email_verifications_email" ON "email_verifications" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_milestone_verifications_deal_ms" ON "milestone_verifications" USING btree ("deal_address","milestone_id");