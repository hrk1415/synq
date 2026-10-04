CREATE TABLE "milestone_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"deal_address" text NOT NULL,
	"milestone_id" integer NOT NULL,
	"submission_version" integer NOT NULL,
	"client_wallet" text NOT NULL,
	"freelancer_wallet" text NOT NULL,
	"spec_hash" text NOT NULL,
	"evidence_root_hash" text NOT NULL,
	"reason_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"proposed_revision_deadline" numeric(78, 0) NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"tx_hash" text,
	"requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_milestone_revisions_deal_lower" CHECK (deal_address = LOWER(deal_address)),
	CONSTRAINT "chk_milestone_revisions_client_lower" CHECK (client_wallet = LOWER(client_wallet)),
	CONSTRAINT "chk_milestone_revisions_freelancer_lower" CHECK (freelancer_wallet = LOWER(freelancer_wallet)),
	CONSTRAINT "chk_milestone_revisions_spec_lower" CHECK (spec_hash = LOWER(spec_hash)),
	CONSTRAINT "chk_milestone_revisions_evidence_lower" CHECK (evidence_root_hash = LOWER(evidence_root_hash)),
	CONSTRAINT "chk_milestone_revisions_reason_lower" CHECK (reason_hash = LOWER(reason_hash)),
	CONSTRAINT "chk_milestone_revisions_status_valid" CHECK (status IN ('staged', 'confirmed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_milestone_revisions_deal_ms_ver" ON "milestone_revisions" USING btree ("chain_id","deal_address","milestone_id","submission_version");
--> statement-breakpoint
CREATE INDEX "idx_milestone_revisions_deal" ON "milestone_revisions" USING btree ("chain_id","deal_address");
--> statement-breakpoint
CREATE INDEX "idx_milestone_revisions_reason_hash" ON "milestone_revisions" USING btree ("reason_hash");
--> statement-breakpoint
CREATE INDEX "idx_milestone_revisions_client" ON "milestone_revisions" USING btree ("client_wallet");
--> statement-breakpoint
CREATE INDEX "idx_milestone_revisions_freelancer" ON "milestone_revisions" USING btree ("freelancer_wallet");
