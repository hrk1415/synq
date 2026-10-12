-- Migration 0013: Premium Protection Selection (Phase 4A)
-- Adds protection_selection to deal_proposals with default 'STANDARD'
-- Fully backward-compatible with existing proposals.

ALTER TABLE "deal_proposals"
  ADD COLUMN IF NOT EXISTS "protection_selection" text DEFAULT 'STANDARD' NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_deal_proposals_protection_valid'
  ) THEN
    ALTER TABLE "deal_proposals"
      ADD CONSTRAINT "chk_deal_proposals_protection_valid"
      CHECK (protection_selection IN ('STANDARD', 'PREMIUM'));
  END IF;
END $$;
