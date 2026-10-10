CREATE TABLE "otp_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"last_requested_at" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_otp_rate_limits_key_lower" CHECK (key = LOWER(key))
);
