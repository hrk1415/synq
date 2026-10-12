CREATE TABLE "deal_proposals" (
	"proposal_id" text PRIMARY KEY NOT NULL,
	"proposal_nonce" numeric(78, 0) NOT NULL,
	"chain_id" integer NOT NULL,
	"factory_address" text NOT NULL,
	"client_wallet" text NOT NULL,
	"freelancer_wallet" text NOT NULL,
	"canonical_usdc" text NOT NULL,
	"deal_implementation" text NOT NULL,
	"primary_resolver" text NOT NULL,
	"emergency_resolver" text NOT NULL,
	"milestones_hash" text NOT NULL,
	"is_protected" boolean NOT NULL,
	"protection_module" text NOT NULL,
	"policy_id" text NOT NULL,
	"expiry" numeric(78, 0) NOT NULL,
	"client_signature" text NOT NULL,
	"title" text NOT NULL,
	"scope" text NOT NULL,
	"total_amount" numeric(78, 0) NOT NULL,
	"milestones" jsonb NOT NULL,
	"cached_status" text DEFAULT 'PENDING' NOT NULL,
	"deal_address" text,
	"accepted_tx_hash" text,
	"declined_tx_hash" text,
	"cancelled_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_deal_proposals_client_lower" CHECK (client_wallet = LOWER(client_wallet)),
	CONSTRAINT "chk_deal_proposals_freelancer_lower" CHECK (freelancer_wallet = LOWER(freelancer_wallet)),
	CONSTRAINT "chk_deal_proposals_factory_lower" CHECK (factory_address = LOWER(factory_address)),
	CONSTRAINT "chk_deal_proposals_deal_addr_lower" CHECK (deal_address IS NULL OR deal_address = LOWER(deal_address)),
	CONSTRAINT "chk_deal_proposals_status_valid" CHECK (cached_status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deal_proposals_client_nonce" ON "deal_proposals" USING btree ("chain_id","factory_address","client_wallet","proposal_nonce");
--> statement-breakpoint
CREATE INDEX "idx_deal_proposals_client" ON "deal_proposals" USING btree ("client_wallet");
--> statement-breakpoint
CREATE INDEX "idx_deal_proposals_freelancer" ON "deal_proposals" USING btree ("freelancer_wallet");
--> statement-breakpoint
CREATE INDEX "idx_deal_proposals_deal_address" ON "deal_proposals" USING btree ("deal_address");
--> statement-breakpoint
CREATE INDEX "idx_deal_proposals_status" ON "deal_proposals" USING btree ("cached_status");
