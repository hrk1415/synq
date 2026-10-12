CREATE TABLE "ai_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_ai_conv_wallet_lower" CHECK (wallet_address = LOWER(wallet_address))
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_ai_msg_role_valid" CHECK (role IN ('user', 'ai', 'system'))
);
--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_conversations_wallet_updated" ON "ai_conversations" USING btree ("wallet_address","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_ai_messages_conv_created" ON "ai_messages" USING btree ("conversation_id","created_at","id");