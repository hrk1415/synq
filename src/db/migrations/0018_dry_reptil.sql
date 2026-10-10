ALTER TABLE "deal_events_outbox" DROP CONSTRAINT "chk_deal_events_outbox_status_valid";--> statement-breakpoint
ALTER TABLE "deal_events_outbox" ADD COLUMN "origin" text DEFAULT 'off_chain' NOT NULL;--> statement-breakpoint
ALTER TABLE "deal_events_outbox" ADD COLUMN "block_number" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "deal_events_outbox" ADD COLUMN "block_hash" text;--> statement-breakpoint
ALTER TABLE "deal_events_outbox" ADD COLUMN "tx_hash" text;--> statement-breakpoint
ALTER TABLE "deal_events_outbox" ADD COLUMN "log_index" integer;--> statement-breakpoint
CREATE INDEX "idx_deal_events_outbox_reorg" ON "deal_events_outbox" USING btree ("chain_id","origin","block_number");--> statement-breakpoint
ALTER TABLE "deal_events_outbox" ADD CONSTRAINT "chk_deal_events_outbox_origin_valid" CHECK (origin IN ('on_chain', 'off_chain'));--> statement-breakpoint
ALTER TABLE "deal_events_outbox" ADD CONSTRAINT "chk_deal_events_outbox_status_valid" CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'skipped', 'cancelled'));