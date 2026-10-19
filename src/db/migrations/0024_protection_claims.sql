-- Migration 0024: Protection Claims (Phase 3C)
-- Provides durable off-chain persistence for canonical protection claim manifests.
-- Cryptographically committed on-chain via SynqPremiumProtectionManagerV1_1.submitClaim(address, uint256, bytes32).
-- Fully backward-compatible with existing tables.

CREATE TABLE IF NOT EXISTS "protection_claims" (
  "id" text PRIMARY KEY,
  "chain_id" integer NOT NULL,
  "manager_address" text NOT NULL,
  "deal_address" text NOT NULL,
  "milestone_id" integer NOT NULL,
  "client_wallet" text NOT NULL,
  "evidence_hash" text NOT NULL,
  "canonical_manifest" jsonb NOT NULL,
  "status" text DEFAULT 'staged' NOT NULL,
  "tx_hash" text,
  "submitted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_protection_claims_deal_ms"
  ON "protection_claims" ("chain_id", "deal_address", "milestone_id");

CREATE INDEX IF NOT EXISTS "idx_protection_claims_deal"
  ON "protection_claims" ("chain_id", "deal_address");

CREATE INDEX IF NOT EXISTS "idx_protection_claims_evidence_hash"
  ON "protection_claims" ("evidence_hash");

CREATE INDEX IF NOT EXISTS "idx_protection_claims_client"
  ON "protection_claims" ("client_wallet");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_protection_claims_deal_lower') THEN
    ALTER TABLE "protection_claims" ADD CONSTRAINT "chk_protection_claims_deal_lower" CHECK (deal_address = LOWER(deal_address));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_protection_claims_manager_lower') THEN
    ALTER TABLE "protection_claims" ADD CONSTRAINT "chk_protection_claims_manager_lower" CHECK (manager_address = LOWER(manager_address));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_protection_claims_client_lower') THEN
    ALTER TABLE "protection_claims" ADD CONSTRAINT "chk_protection_claims_client_lower" CHECK (client_wallet = LOWER(client_wallet));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_protection_claims_evidence_lower') THEN
    ALTER TABLE "protection_claims" ADD CONSTRAINT "chk_protection_claims_evidence_lower" CHECK (evidence_hash = LOWER(evidence_hash));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_protection_claims_status_valid') THEN
    ALTER TABLE "protection_claims" ADD CONSTRAINT "chk_protection_claims_status_valid" CHECK (status IN ('staged', 'confirmed'));
  END IF;
END $$;
