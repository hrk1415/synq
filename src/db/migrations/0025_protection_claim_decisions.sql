-- Migration 0025: Protection Claim Decisions (Phase 3D.2)
-- Dedicated tables for Protection Committee claim reviews, canonical decision reports,
-- EIP-712 typed-data authorizations, and multi-signer threshold signatures.
-- Fully additive and backward-compatible with all existing tables.

CREATE TABLE IF NOT EXISTS "protection_claim_decisions" (
  "id" text PRIMARY KEY NOT NULL,
  "claim_id" text,
  "chain_id" integer NOT NULL,
  "committee_address" text NOT NULL,
  "manager_address" text NOT NULL,
  "deal_address" text NOT NULL,
  "milestone_id" integer NOT NULL,
  "claim_evidence_hash" text NOT NULL,
  "decision" integer NOT NULL,
  "decision_nonce" numeric(78, 0) NOT NULL,
  "valid_until" numeric(78, 0) NOT NULL,
  "decision_report_hash" text NOT NULL,
  "canonical_report" jsonb NOT NULL,
  "typed_data" jsonb NOT NULL,
  "typed_data_hash" text NOT NULL,
  "status" text DEFAULT 'collecting' NOT NULL,
  "created_by_signer" text NOT NULL,
  "execution_tx_hash" text,
  "executed_by_wallet" text,
  "executed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "protection_claim_signatures" (
  "id" text PRIMARY KEY NOT NULL,
  "decision_id" text NOT NULL,
  "signer_wallet" text NOT NULL,
  "signature" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Indexes for protection_claim_decisions
CREATE UNIQUE INDEX IF NOT EXISTS "uq_prot_dec_nonce"
  ON "protection_claim_decisions" ("chain_id", "manager_address", "deal_address", "milestone_id", "decision_nonce");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_prot_dec_active_claim"
  ON "protection_claim_decisions" ("chain_id", "manager_address", "deal_address", "milestone_id")
  WHERE (status IN ('collecting', 'threshold_ready'));

CREATE INDEX IF NOT EXISTS "idx_prot_dec_deal_ms"
  ON "protection_claim_decisions" ("chain_id", "deal_address", "milestone_id");

CREATE INDEX IF NOT EXISTS "idx_prot_dec_committee"
  ON "protection_claim_decisions" ("committee_address");

CREATE INDEX IF NOT EXISTS "idx_prot_dec_report_hash"
  ON "protection_claim_decisions" ("decision_report_hash");

CREATE INDEX IF NOT EXISTS "idx_prot_dec_typed_hash"
  ON "protection_claim_decisions" ("typed_data_hash");

CREATE INDEX IF NOT EXISTS "idx_prot_dec_status"
  ON "protection_claim_decisions" ("status");

CREATE INDEX IF NOT EXISTS "idx_prot_dec_execution_tx"
  ON "protection_claim_decisions" ("execution_tx_hash");

CREATE INDEX IF NOT EXISTS "idx_prot_dec_claim_id"
  ON "protection_claim_decisions" ("claim_id");

-- Indexes for protection_claim_signatures
CREATE UNIQUE INDEX IF NOT EXISTS "uq_prot_sig_decision_signer"
  ON "protection_claim_signatures" ("decision_id", "signer_wallet");

CREATE INDEX IF NOT EXISTS "idx_prot_sig_decision"
  ON "protection_claim_signatures" ("decision_id");

CREATE INDEX IF NOT EXISTS "idx_prot_sig_signer"
  ON "protection_claim_signatures" ("signer_wallet");

-- Constraints
DO $$
BEGIN
  -- Foreign key with non-destructive ON DELETE RESTRICT
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_prot_sig_decision'
  ) THEN
    ALTER TABLE "protection_claim_signatures"
      ADD CONSTRAINT "fk_prot_sig_decision"
      FOREIGN KEY ("decision_id")
      REFERENCES "protection_claim_decisions"("id")
      ON DELETE RESTRICT;
  END IF;

  -- Lowercase and integrity constraints for protection_claim_decisions
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_committee_lower') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_committee_lower" CHECK (committee_address = LOWER(committee_address));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_manager_lower') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_manager_lower" CHECK (manager_address = LOWER(manager_address));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_deal_lower') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_deal_lower" CHECK (deal_address = LOWER(deal_address));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_created_by_lower') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_created_by_lower" CHECK (created_by_signer = LOWER(created_by_signer));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_claim_evidence_lower') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_claim_evidence_lower" CHECK (claim_evidence_hash = LOWER(claim_evidence_hash));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_report_hash_lower') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_report_hash_lower" CHECK (decision_report_hash = LOWER(decision_report_hash));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_typed_hash_lower') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_typed_hash_lower" CHECK (typed_data_hash = LOWER(typed_data_hash));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_executed_by_lower') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_executed_by_lower" CHECK (executed_by_wallet IS NULL OR executed_by_wallet = LOWER(executed_by_wallet));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_execution_tx_lower') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_execution_tx_lower" CHECK (execution_tx_hash IS NULL OR execution_tx_hash = LOWER(execution_tx_hash));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_decision_valid') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_decision_valid" CHECK (decision IN (1, 2));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_status_valid') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_status_valid" CHECK (status IN ('collecting', 'threshold_ready', 'executed', 'expired', 'invalidated'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_nonce_bounds') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_nonce_bounds" CHECK (decision_nonce >= 0 AND decision_nonce <= 18446744073709551615);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_valid_until_bounds') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_valid_until_bounds" CHECK (valid_until >= 0 AND valid_until <= 18446744073709551615);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_dec_milestone_valid') THEN
    ALTER TABLE "protection_claim_decisions" ADD CONSTRAINT "chk_prot_dec_milestone_valid" CHECK (milestone_id >= 0 AND milestone_id < 16);
  END IF;

  -- Constraints for protection_claim_signatures
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prot_sig_signer_lower') THEN
    ALTER TABLE "protection_claim_signatures" ADD CONSTRAINT "chk_prot_sig_signer_lower" CHECK (signer_wallet = LOWER(signer_wallet));
  END IF;
END $$;
