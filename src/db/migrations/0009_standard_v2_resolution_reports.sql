CREATE TABLE "milestone_resolution_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"committee_address" text NOT NULL,
	"deal_address" text NOT NULL,
	"milestone_id" integer NOT NULL,
	"phase" text NOT NULL,
	"submission_version" integer NOT NULL,
	"spec_hash" text NOT NULL,
	"evidence_root_hash" text NOT NULL,
	"freelancer_amount" numeric(78, 0) NOT NULL,
	"client_amount" numeric(78, 0) NOT NULL,
	"justification_hash" text NOT NULL,
	"canonical_report" jsonb NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"tx_hash" text,
	"staged_by_wallet" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_milestone_resolution_reports_deal_lower" CHECK (deal_address = LOWER(deal_address)),
	CONSTRAINT "chk_milestone_resolution_reports_committee_lower" CHECK (committee_address = LOWER(committee_address)),
	CONSTRAINT "chk_milestone_resolution_reports_staged_by_lower" CHECK (staged_by_wallet = LOWER(staged_by_wallet)),
	CONSTRAINT "chk_milestone_resolution_reports_spec_lower" CHECK (spec_hash = LOWER(spec_hash)),
	CONSTRAINT "chk_milestone_resolution_reports_evidence_lower" CHECK (evidence_root_hash = LOWER(evidence_root_hash)),
	CONSTRAINT "chk_milestone_resolution_reports_justification_lower" CHECK (justification_hash = LOWER(justification_hash)),
	CONSTRAINT "chk_milestone_resolution_reports_phase_valid" CHECK (phase IN ('INITIAL_RESOLUTION', 'FINAL_RESOLUTION')),
	CONSTRAINT "chk_milestone_resolution_reports_status_valid" CHECK (status IN ('staged', 'confirmed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_milestone_resolution_reports_candidate" ON "milestone_resolution_reports" USING btree ("chain_id","deal_address","milestone_id","phase","justification_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_milestone_resolution_reports_confirmed" ON "milestone_resolution_reports" USING btree ("chain_id","deal_address","milestone_id","phase") WHERE status = 'confirmed';
--> statement-breakpoint
CREATE INDEX "idx_milestone_resolution_reports_deal_ms" ON "milestone_resolution_reports" USING btree ("chain_id","deal_address","milestone_id");
--> statement-breakpoint
CREATE INDEX "idx_milestone_resolution_reports_justification" ON "milestone_resolution_reports" USING btree ("justification_hash");
--> statement-breakpoint
CREATE INDEX "idx_milestone_resolution_reports_committee" ON "milestone_resolution_reports" USING btree ("committee_address");
--> statement-breakpoint
CREATE INDEX "idx_milestone_resolution_reports_staged_by" ON "milestone_resolution_reports" USING btree ("staged_by_wallet");
--> statement-breakpoint
CREATE INDEX "idx_milestone_resolution_reports_tx_hash" ON "milestone_resolution_reports" USING btree ("tx_hash");
