ALTER TABLE "conversations" ADD COLUMN "participant_a" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "participant_b" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "buyer_name" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "seller_name" text;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "conversations"
    WHERE "buyer_wallet" !~* '^0x[0-9a-f]{40}$'
       OR "seller_wallet" !~* '^0x[0-9a-f]{40}$'
       OR LOWER("buyer_wallet") = LOWER("seller_wallet")
  ) THEN
    RAISE EXCEPTION 'Cannot canonicalize conversations: invalid wallet or self-conversation legacy row requires manual remediation';
  END IF;
END $$;--> statement-breakpoint

UPDATE "conversations"
SET
  "participant_a" = CASE
    WHEN DECODE(SUBSTR(LOWER("buyer_wallet"), 3), 'hex') < DECODE(SUBSTR(LOWER("seller_wallet"), 3), 'hex')
      THEN LOWER("buyer_wallet")
    ELSE LOWER("seller_wallet")
  END,
  "participant_b" = CASE
    WHEN DECODE(SUBSTR(LOWER("buyer_wallet"), 3), 'hex') < DECODE(SUBSTR(LOWER("seller_wallet"), 3), 'hex')
      THEN LOWER("seller_wallet")
    ELSE LOWER("buyer_wallet")
  END;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "conversations"
    WHERE "deal_address" IS NOT NULL
    GROUP BY "participant_a", "participant_b"
    HAVING COUNT(DISTINCT "deal_address") > 1
  ) THEN
    RAISE EXCEPTION 'Cannot merge canonical conversations: conflicting deal_address values require manual remediation';
  END IF;
END $$;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    WITH oriented AS (
      SELECT
        "participant_a",
        "participant_b",
        "buyer_wallet",
        "seller_wallet",
        "order_meta",
        FIRST_VALUE("buyer_wallet") OVER (
          PARTITION BY "participant_a", "participant_b"
          ORDER BY "created_at" ASC, "id" ASC
        ) AS "retained_buyer_wallet",
        FIRST_VALUE("seller_wallet") OVER (
          PARTITION BY "participant_a", "participant_b"
          ORDER BY "created_at" ASC, "id" ASC
        ) AS "retained_seller_wallet"
      FROM "conversations"
    )
    SELECT 1
    FROM oriented
    WHERE "order_meta" IS NOT NULL
      AND (
        LOWER("buyer_wallet") <> LOWER("retained_buyer_wallet")
        OR LOWER("seller_wallet") <> LOWER("retained_seller_wallet")
      )
  ) THEN
    RAISE EXCEPTION 'Cannot merge canonical conversations: order_meta exists under incompatible buyer/seller roles and requires manual remediation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "conversations"
    WHERE "order_meta" IS NOT NULL
    GROUP BY "participant_a", "participant_b"
    HAVING COUNT(DISTINCT "order_meta") > 1
  ) THEN
    RAISE EXCEPTION 'Cannot merge canonical conversations: conflicting order_meta values require manual remediation';
  END IF;
END $$;--> statement-breakpoint

CREATE TEMP TABLE "synq_conversation_merge" AS
WITH ranked AS (
  SELECT
    "id" AS "duplicate_id",
    FIRST_VALUE("id") OVER (
      PARTITION BY "participant_a", "participant_b"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS "retained_id",
    ROW_NUMBER() OVER (
      PARTITION BY "participant_a", "participant_b"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS "pair_rank"
  FROM "conversations"
)
SELECT "duplicate_id", "retained_id"
FROM ranked
WHERE "pair_rank" > 1;--> statement-breakpoint

WITH merged_values AS (
  SELECT
    "participant_a",
    "participant_b",
    (ARRAY_AGG("subject" ORDER BY "created_at", "id") FILTER (WHERE "subject" IS NOT NULL))[1] AS "subject",
    (ARRAY_AGG("order_meta" ORDER BY "created_at", "id") FILTER (WHERE "order_meta" IS NOT NULL))[1] AS "order_meta",
    (ARRAY_AGG("deal_address" ORDER BY "created_at", "id") FILTER (WHERE "deal_address" IS NOT NULL))[1] AS "deal_address"
  FROM "conversations"
  GROUP BY "participant_a", "participant_b"
), latest_activity AS (
  SELECT DISTINCT ON ("participant_a", "participant_b")
    "participant_a",
    "participant_b",
    "last_message_at",
    "last_message_preview",
    "last_message_from",
    "updated_at"
  FROM "conversations"
  ORDER BY "participant_a", "participant_b", "last_message_at" DESC, "created_at" ASC, "id" ASC
), latest_updates AS (
  SELECT
    "participant_a",
    "participant_b",
    MAX("updated_at") AS "updated_at"
  FROM "conversations"
  GROUP BY "participant_a", "participant_b"
)
UPDATE "conversations" AS retained
SET
  "subject" = COALESCE(retained."subject", merged_values."subject"),
  "order_meta" = COALESCE(retained."order_meta", merged_values."order_meta"),
  "deal_address" = COALESCE(retained."deal_address", merged_values."deal_address"),
  "last_message_at" = latest_activity."last_message_at",
  "last_message_preview" = latest_activity."last_message_preview",
  "last_message_from" = latest_activity."last_message_from",
  "updated_at" = latest_updates."updated_at"
FROM merged_values, latest_activity, latest_updates
WHERE retained."participant_a" = merged_values."participant_a"
  AND retained."participant_b" = merged_values."participant_b"
  AND retained."participant_a" = latest_activity."participant_a"
  AND retained."participant_b" = latest_activity."participant_b"
  AND retained."participant_a" = latest_updates."participant_a"
  AND retained."participant_b" = latest_updates."participant_b"
  AND NOT EXISTS (
    SELECT 1 FROM "synq_conversation_merge" m WHERE m."duplicate_id" = retained."id"
  );--> statement-breakpoint

UPDATE "messages" AS message
SET "conversation_id" = merge."retained_id"
FROM "synq_conversation_merge" AS merge
WHERE message."conversation_id" = merge."duplicate_id";--> statement-breakpoint

DELETE FROM "conversations" AS conversation
USING "synq_conversation_merge" AS merge
WHERE conversation."id" = merge."duplicate_id";--> statement-breakpoint

DROP TABLE "synq_conversation_merge";--> statement-breakpoint

ALTER TABLE "conversations" ALTER COLUMN "participant_a" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "participant_b" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "chk_conv_participant_a_lower" CHECK ("participant_a" = LOWER("participant_a"));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "chk_conv_participant_b_lower" CHECK ("participant_b" = LOWER("participant_b"));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "chk_conv_participant_order" CHECK (DECODE(SUBSTR("participant_a", 3), 'hex') < DECODE(SUBSTR("participant_b", 3), 'hex'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "chk_conv_participant_a_evm" CHECK ("participant_a" ~ '^0x[0-9a-f]{40}$');--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "chk_conv_participant_b_evm" CHECK ("participant_b" ~ '^0x[0-9a-f]{40}$');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversations_participant_pair" ON "conversations" USING btree ("participant_a", "participant_b");--> statement-breakpoint
CREATE INDEX "idx_conversations_participant_b" ON "conversations" USING btree ("participant_b");
