CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"wallet_address" text PRIMARY KEY NOT NULL,
	"deal_proposals_and_confirmations" boolean DEFAULT true NOT NULL,
	"milestone_submissions_and_revisions" boolean DEFAULT true NOT NULL,
	"payments_and_completions" boolean DEFAULT true NOT NULL,
	"disputes_and_resolutions" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_notif_pref_wallet_lower" CHECK (wallet_address = LOWER(wallet_address))
);
