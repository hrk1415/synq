ALTER TABLE "deal_proposals" ADD COLUMN IF NOT EXISTS "deployment_block" numeric(78, 0);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deal_proposals_deployment_block" ON "deal_proposals" USING btree ("deployment_block");
