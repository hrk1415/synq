CREATE TABLE IF NOT EXISTS "chain_sync_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"scanner_id" text NOT NULL,
	"last_block_number" numeric(78, 0) NOT NULL,
	"last_block_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_chain_sync_cursors_hash_lower" CHECK (last_block_hash = LOWER(last_block_hash))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deal_events_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"deal_id" text NOT NULL,
	"event" text NOT NULL,
	"recipient_wallet" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "chk_deal_events_outbox_recipient_lower" CHECK (recipient_wallet = LOWER(recipient_wallet)),
	CONSTRAINT "chk_deal_events_outbox_status_valid" CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_chain_sync_cursors_chain_scanner" ON "chain_sync_cursors" USING btree ("chain_id","scanner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chain_sync_cursors_scanner" ON "chain_sync_cursors" USING btree ("scanner_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_deal_events_outbox_id" ON "deal_events_outbox" USING btree ("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deal_events_outbox_status" ON "deal_events_outbox" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deal_events_outbox_deal" ON "deal_events_outbox" USING btree ("deal_id");