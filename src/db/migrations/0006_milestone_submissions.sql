CREATE TABLE "milestone_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"deal_address" text NOT NULL,
	"milestone_id" integer NOT NULL,
	"version" integer NOT NULL,
	"freelancer_wallet" text NOT NULL,
	"spec_hash" text NOT NULL,
	"evidence_root_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"tx_hash" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_milestone_submissions_deal_lower" CHECK (deal_address = LOWER(deal_address)),
	CONSTRAINT "chk_milestone_submissions_freelancer_lower" CHECK (freelancer_wallet = LOWER(freelancer_wallet)),
	CONSTRAINT "chk_milestone_submissions_spec_lower" CHECK (spec_hash = LOWER(spec_hash)),
	CONSTRAINT "chk_milestone_submissions_evidence_lower" CHECK (evidence_root_hash = LOWER(evidence_root_hash)),
	CONSTRAINT "chk_milestone_submissions_status_valid" CHECK (status IN ('staged', 'confirmed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_milestone_submissions_deal_ms_ver" ON "milestone_submissions" USING btree ("chain_id","deal_address","milestone_id","version");
--> statement-breakpoint
CREATE INDEX "idx_milestone_submissions_deal" ON "milestone_submissions" USING btree ("chain_id","deal_address");
--> statement-breakpoint
CREATE INDEX "idx_milestone_submissions_evidence_hash" ON "milestone_submissions" USING btree ("evidence_root_hash");
--> statement-breakpoint
CREATE INDEX "idx_milestone_submissions_freelancer" ON "milestone_submissions" USING btree ("freelancer_wallet");
