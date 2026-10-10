CREATE TABLE "deal_replay_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"contract_address" text NOT NULL,
	"contract_type" text NOT NULL,
	"generation" text NOT NULL,
	"from_block" numeric(78, 0) NOT NULL,
	"to_block" numeric(78, 0) NOT NULL,
	"last_processed_block" numeric(78, 0),
	"status" text DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 5 NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"last_error" text,
	"next_retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_deal_replay_jobs_addr_lower" CHECK (contract_address = LOWER(contract_address)),
	CONSTRAINT "chk_deal_replay_jobs_status_valid" CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
	CONSTRAINT "chk_deal_replay_jobs_generation_valid" CHECK (generation IN ('v2', 'v1', 'legacy')),
	CONSTRAINT "chk_deal_replay_jobs_type_valid" CHECK (contract_type IN ('deal_v1', 'deal_v2'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deal_replay_jobs_chain_contract" ON "deal_replay_jobs" USING btree ("chain_id","contract_address");--> statement-breakpoint
CREATE INDEX "idx_deal_replay_jobs_status_retry" ON "deal_replay_jobs" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "idx_deal_replay_jobs_contract" ON "deal_replay_jobs" USING btree ("chain_id","contract_address");
