CREATE TABLE "milestone_disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"deal_address" text NOT NULL,
	"milestone_id" integer NOT NULL,
	"submission_version" integer NOT NULL,
	"spec_hash" text NOT NULL,
	"evidence_root_hash" text NOT NULL,
	"opener_wallet" text NOT NULL,
	"counterparty_wallet" text NOT NULL,
	"reason_hash" text NOT NULL,
	"canonical_manifest" jsonb NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"tx_hash" text,
	"opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_milestone_disputes_deal_lower" CHECK (deal_address = LOWER(deal_address)),
	CONSTRAINT "chk_milestone_disputes_opener_lower" CHECK (opener_wallet = LOWER(opener_wallet)),
	CONSTRAINT "chk_milestone_disputes_counterparty_lower" CHECK (counterparty_wallet = LOWER(counterparty_wallet)),
	CONSTRAINT "chk_milestone_disputes_spec_lower" CHECK (spec_hash = LOWER(spec_hash)),
	CONSTRAINT "chk_milestone_disputes_evidence_lower" CHECK (evidence_root_hash = LOWER(evidence_root_hash)),
	CONSTRAINT "chk_milestone_disputes_reason_lower" CHECK (reason_hash = LOWER(reason_hash)),
	CONSTRAINT "chk_milestone_disputes_status_valid" CHECK (status IN ('staged', 'confirmed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_milestone_disputes_deal_ms" ON "milestone_disputes" USING btree ("chain_id","deal_address","milestone_id");
--> statement-breakpoint
CREATE INDEX "idx_milestone_disputes_deal" ON "milestone_disputes" USING btree ("chain_id","deal_address");
--> statement-breakpoint
CREATE INDEX "idx_milestone_disputes_reason_hash" ON "milestone_disputes" USING btree ("reason_hash");
--> statement-breakpoint
CREATE INDEX "idx_milestone_disputes_opener" ON "milestone_disputes" USING btree ("opener_wallet");
--> statement-breakpoint
CREATE INDEX "idx_milestone_disputes_counterparty" ON "milestone_disputes" USING btree ("counterparty_wallet");
--> statement-breakpoint
CREATE TABLE "mutual_settlement_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"deal_address" text NOT NULL,
	"milestone_id" integer NOT NULL,
	"proposer_wallet" text NOT NULL,
	"counterparty_wallet" text NOT NULL,
	"freelancer_amount" numeric(78, 0) NOT NULL,
	"client_amount" numeric(78, 0) NOT NULL,
	"proposal_nonce" numeric(78, 0) NOT NULL,
	"valid_until" numeric(78, 0) NOT NULL,
	"signature" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"execution_tx_hash" text,
	"cancellation_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_mutual_settlements_deal_lower" CHECK (deal_address = LOWER(deal_address)),
	CONSTRAINT "chk_mutual_settlements_proposer_lower" CHECK (proposer_wallet = LOWER(proposer_wallet)),
	CONSTRAINT "chk_mutual_settlements_counterparty_lower" CHECK (counterparty_wallet = LOWER(counterparty_wallet)),
	CONSTRAINT "chk_mutual_settlements_status_valid" CHECK (status IN ('pending', 'executed', 'cancelled', 'expired', 'invalidated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mutual_settlements_nonce" ON "mutual_settlement_proposals" USING btree ("chain_id","deal_address","milestone_id","proposer_wallet","proposal_nonce");
--> statement-breakpoint
CREATE INDEX "idx_mutual_settlements_deal_ms" ON "mutual_settlement_proposals" USING btree ("chain_id","deal_address","milestone_id");
--> statement-breakpoint
CREATE INDEX "idx_mutual_settlements_proposer" ON "mutual_settlement_proposals" USING btree ("proposer_wallet");
--> statement-breakpoint
CREATE INDEX "idx_mutual_settlements_counterparty" ON "mutual_settlement_proposals" USING btree ("counterparty_wallet");
--> statement-breakpoint
CREATE INDEX "idx_mutual_settlements_status" ON "mutual_settlement_proposals" USING btree ("status");
