CREATE TABLE IF NOT EXISTS "deal_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"event" text NOT NULL,
	"recipient_wallet" text NOT NULL,
	"recipient_email" text,
	"status" text NOT NULL,
	"message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_deal_notifications_recipient_lower" CHECK (recipient_wallet = LOWER(recipient_wallet))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_deal_notifications_id" ON "deal_notifications" USING btree ("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deal_notifications_deal" ON "deal_notifications" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deal_notifications_status" ON "deal_notifications" USING btree ("status");--> statement-breakpoint
ALTER TABLE "deal_proposals" ADD COLUMN IF NOT EXISTS "protection_selection" text DEFAULT 'STANDARD' NOT NULL;--> statement-breakpoint
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