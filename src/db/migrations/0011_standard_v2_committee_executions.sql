-- Migration 0011: Standard V2 Committee Resolution Execution Metadata
-- Extends committee_resolution_authorizations with execution tracking columns and adds 'executed' to status constraint.

ALTER TABLE "committee_resolution_authorizations"
  ADD COLUMN IF NOT EXISTS "execution_tx_hash" text,
  ADD COLUMN IF NOT EXISTS "executed_by_wallet" text,
  ADD COLUMN IF NOT EXISTS "executed_at" timestamp with time zone;

-- Enforce lowercase for executed_by_wallet when present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_comm_auth_executed_by_lower'
  ) THEN
    ALTER TABLE "committee_resolution_authorizations"
      ADD CONSTRAINT "chk_comm_auth_executed_by_lower"
      CHECK (executed_by_wallet IS NULL OR executed_by_wallet = LOWER(executed_by_wallet));
  END IF;
END $$;

-- Update status check constraint to include 'executed'
ALTER TABLE "committee_resolution_authorizations"
  DROP CONSTRAINT IF EXISTS "chk_comm_auth_status_valid";

ALTER TABLE "committee_resolution_authorizations"
  ADD CONSTRAINT "chk_comm_auth_status_valid"
  CHECK (status IN ('collecting', 'threshold_ready', 'invalidated', 'expired', 'executed'));

-- Index on execution_tx_hash for fast reconciliation lookups
CREATE INDEX IF NOT EXISTS "idx_comm_auth_execution_tx"
  ON "committee_resolution_authorizations" USING btree ("execution_tx_hash");
