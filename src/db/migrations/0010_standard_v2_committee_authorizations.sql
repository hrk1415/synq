CREATE TABLE "committee_resolution_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"committee_address" text NOT NULL,
	"deal_address" text NOT NULL,
	"milestone_id" integer NOT NULL,
	"phase" text NOT NULL,
	"authorization_type" text NOT NULL,
	"resolution_nonce" numeric(78, 0) NOT NULL,
	"valid_until" numeric(78, 0) NOT NULL,
	"committee_epoch" numeric(78, 0) NOT NULL,
	"submission_version" integer NOT NULL,
	"spec_hash" text NOT NULL,
	"evidence_root_hash" text NOT NULL,
	"freelancer_amount" numeric(78, 0) NOT NULL,
	"client_amount" numeric(78, 0) NOT NULL,
	"justification_hash" text NOT NULL,
	"typed_data" jsonb NOT NULL,
	"typed_data_hash" text NOT NULL,
	"status" text DEFAULT 'collecting' NOT NULL,
	"created_by_signer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_comm_auth_deal_lower" CHECK (deal_address = LOWER(deal_address)),
	CONSTRAINT "chk_comm_auth_committee_lower" CHECK (committee_address = LOWER(committee_address)),
	CONSTRAINT "chk_comm_auth_created_by_lower" CHECK (created_by_signer = LOWER(created_by_signer)),
	CONSTRAINT "chk_comm_auth_spec_lower" CHECK (spec_hash = LOWER(spec_hash)),
	CONSTRAINT "chk_comm_auth_evidence_lower" CHECK (evidence_root_hash = LOWER(evidence_root_hash)),
	CONSTRAINT "chk_comm_auth_justification_lower" CHECK (justification_hash = LOWER(justification_hash)),
	CONSTRAINT "chk_comm_auth_typed_hash_lower" CHECK (typed_data_hash = LOWER(typed_data_hash)),
	CONSTRAINT "chk_comm_auth_phase_valid" CHECK (phase IN ('INITIAL_RESOLUTION', 'FINAL_RESOLUTION')),
	CONSTRAINT "chk_comm_auth_type_valid" CHECK (authorization_type IN ('ResolutionProposalAuth', 'FinalResolutionAuth')),
	CONSTRAINT "chk_comm_auth_status_valid" CHECK (status IN ('collecting', 'threshold_ready', 'invalidated', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "committee_resolution_signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"authorization_id" text NOT NULL,
	"signer_wallet" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_comm_sig_wallet_lower" CHECK (signer_wallet = LOWER(signer_wallet))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_comm_auth_nonce" ON "committee_resolution_authorizations" USING btree ("chain_id","committee_address","deal_address","milestone_id","phase","resolution_nonce");
--> statement-breakpoint
CREATE INDEX "idx_comm_auth_report" ON "committee_resolution_authorizations" USING btree ("report_id");
--> statement-breakpoint
CREATE INDEX "idx_comm_auth_deal_ms" ON "committee_resolution_authorizations" USING btree ("chain_id","deal_address","milestone_id");
--> statement-breakpoint
CREATE INDEX "idx_comm_auth_committee" ON "committee_resolution_authorizations" USING btree ("committee_address");
--> statement-breakpoint
CREATE INDEX "idx_comm_auth_typed_hash" ON "committee_resolution_authorizations" USING btree ("typed_data_hash");
--> statement-breakpoint
CREATE INDEX "idx_comm_auth_status" ON "committee_resolution_authorizations" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_comm_sig_auth_signer" ON "committee_resolution_signatures" USING btree ("authorization_id","signer_wallet");
--> statement-breakpoint
CREATE INDEX "idx_comm_sig_auth" ON "committee_resolution_signatures" USING btree ("authorization_id");
--> statement-breakpoint
CREATE INDEX "idx_comm_sig_signer" ON "committee_resolution_signatures" USING btree ("signer_wallet");
