CREATE TABLE "tracked_deal_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"contract_address" text NOT NULL,
	"contract_type" text NOT NULL,
	"factory_address" text,
	"deployment_block" numeric(78, 0) NOT NULL,
	"discovery_tx_hash" text,
	"discovery_log_index" integer,
	"buyer_wallet" text,
	"seller_wallet" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_tracked_contracts_addr_lower" CHECK (contract_address = LOWER(contract_address)),
	CONSTRAINT "chk_tracked_contracts_type_valid" CHECK (contract_type IN ('factory', 'deal_v1', 'deal_v2'))
);
--> statement-breakpoint
ALTER TABLE "deal_events_outbox" ADD COLUMN "claim_token" text;--> statement-breakpoint
ALTER TABLE "deal_events_outbox" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deal_events_outbox" ADD COLUMN "next_retry_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "deal_events_outbox" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tracked_deal_contracts_chain_addr" ON "tracked_deal_contracts" USING btree ("chain_id","contract_address");--> statement-breakpoint
CREATE INDEX "idx_tracked_deal_contracts_chain_type" ON "tracked_deal_contracts" USING btree ("chain_id","contract_type");--> statement-breakpoint
CREATE INDEX "idx_tracked_deal_contracts_block" ON "tracked_deal_contracts" USING btree ("deployment_block");--> statement-breakpoint
CREATE INDEX "idx_deal_events_outbox_retry" ON "deal_events_outbox" USING btree ("status","next_retry_at");