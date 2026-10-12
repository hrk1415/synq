-- Migration 0012: Freelancer Pricing V2 (Modern USDC Starting Rate)
-- Extends market_profiles with nullable starting_rate_amount, starting_rate_currency, starting_rate_type.
-- Fully backward-compatible with existing freelancer profiles.

ALTER TABLE "market_profiles"
  ADD COLUMN IF NOT EXISTS "starting_rate_amount" numeric(18, 6),
  ADD COLUMN IF NOT EXISTS "starting_rate_currency" text,
  ADD COLUMN IF NOT EXISTS "starting_rate_type" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_market_profiles_rate_amount_pos'
  ) THEN
    ALTER TABLE "market_profiles"
      ADD CONSTRAINT "chk_market_profiles_rate_amount_pos"
      CHECK (starting_rate_amount IS NULL OR starting_rate_amount > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_market_profiles_rate_currency_usdc'
  ) THEN
    ALTER TABLE "market_profiles"
      ADD CONSTRAINT "chk_market_profiles_rate_currency_usdc"
      CHECK (starting_rate_currency IS NULL OR starting_rate_currency = 'USDC');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_market_profiles_rate_type_valid'
  ) THEN
    ALTER TABLE "market_profiles"
      ADD CONSTRAINT "chk_market_profiles_rate_type_valid"
      CHECK (starting_rate_type IS NULL OR starting_rate_type IN ('PER_PROJECT', 'PER_HOUR'));
  END IF;
END $$;