CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_wallet" text NOT NULL,
	"seller_wallet" text NOT NULL,
	"subject" text,
	"order_meta" jsonb,
	"deal_address" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_preview" text,
	"last_message_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_conv_buyer_lower" CHECK (buyer_wallet = LOWER(buyer_wallet)),
	CONSTRAINT "chk_conv_seller_lower" CHECK (seller_wallet = LOWER(seller_wallet)),
	CONSTRAINT "chk_conv_last_msg_from_lower" CHECK (last_message_from IS NULL OR last_message_from = LOWER(last_message_from))
);
--> statement-breakpoint
CREATE TABLE "market_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"headline" text,
	"secondary_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"about" text,
	"typical_delivery" text,
	"links" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"portfolio" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_name" text,
	"draft_category" text,
	"draft_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_rate" text,
	"draft_bio" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_profiles_wallet_address_unique" UNIQUE("wallet_address"),
	CONSTRAINT "chk_market_profiles_wallet_lower" CHECK (wallet_address = LOWER(wallet_address))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"from_wallet" text NOT NULL,
	"to_wallet" text NOT NULL,
	"from_name" text,
	"body" text NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"order_meta" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_msg_from_lower" CHECK (from_wallet = LOWER(from_wallet)),
	CONSTRAINT "chk_msg_to_lower" CHECK (to_wallet = LOWER(to_wallet))
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_address" text NOT NULL,
	"reviewer_wallet" text NOT NULL,
	"seller_wallet" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"role" text,
	"verified_deal" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_deal_address_unique" UNIQUE("deal_address"),
	CONSTRAINT "chk_reviews_reviewer_lower" CHECK (reviewer_wallet = LOWER(reviewer_wallet)),
	CONSTRAINT "chk_reviews_seller_lower" CHECK (seller_wallet = LOWER(seller_wallet)),
	CONSTRAINT "chk_reviews_rating_range" CHECK (rating >= 1 AND rating <= 5)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"wallet_address" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"avatar" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_users_wallet_lower" CHECK (wallet_address = LOWER(wallet_address))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversations_buyer" ON "conversations" USING btree ("buyer_wallet");--> statement-breakpoint
CREATE INDEX "idx_conversations_seller" ON "conversations" USING btree ("seller_wallet");--> statement-breakpoint
CREATE INDEX "idx_conversations_deal" ON "conversations" USING btree ("deal_address");--> statement-breakpoint
CREATE INDEX "idx_messages_pagination" ON "messages" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_messages_unread" ON "messages" USING btree ("to_wallet","read_at");--> statement-breakpoint
CREATE INDEX "idx_reviews_seller_wallet" ON "reviews" USING btree ("seller_wallet");--> statement-breakpoint
CREATE INDEX "idx_reviews_reviewer_wallet" ON "reviews" USING btree ("reviewer_wallet");