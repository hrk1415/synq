CREATE TABLE IF NOT EXISTS "historical_reconciliation_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"deal_address" text NOT NULL,
	"milestone_id" integer NOT NULL,
	"phase" text NOT NULL,
	"authorization_id" text NOT NULL,
	"bound_report_id" text NOT NULL,
	"on_chain_tx_hash" text NOT NULL,
	"on_chain_justification_hash" text NOT NULL,
	"bound_report_justification_hash" text NOT NULL,
	"recovered_by_wallet" text NOT NULL,
	"narrative_audit_status" text DEFAULT 'unrecoverable_offchain_hash_committed' NOT NULL,
	"notification_status" text DEFAULT 'suppressed_historical_sync' NOT NULL,
	"notification_suppression_reason" text DEFAULT 'historical_synchronization_notification_suppressed' NOT NULL,
	"recovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_reconciliation_audits_authorization_id_committee_resolution_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."committee_resolution_authorizations"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "historical_reconciliation_audits_bound_report_id_milestone_resolution_reports_id_fk" FOREIGN KEY ("bound_report_id") REFERENCES "public"."milestone_resolution_reports"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "chk_hist_recon_deal_lower" CHECK (deal_address = LOWER(deal_address)),
	CONSTRAINT "chk_hist_recon_tx_lower" CHECK (on_chain_tx_hash = LOWER(on_chain_tx_hash)),
	CONSTRAINT "chk_hist_recon_onchain_hash_lower" CHECK (on_chain_justification_hash = LOWER(on_chain_justification_hash)),
	CONSTRAINT "chk_hist_recon_report_hash_lower" CHECK (bound_report_justification_hash = LOWER(bound_report_justification_hash)),
	CONSTRAINT "chk_hist_recon_recovered_by_lower" CHECK (recovered_by_wallet = LOWER(recovered_by_wallet))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hist_recon_auth" ON "historical_reconciliation_audits" USING btree ("authorization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hist_recon_deal_ms" ON "historical_reconciliation_audits" USING btree ("chain_id","deal_address","milestone_id");
