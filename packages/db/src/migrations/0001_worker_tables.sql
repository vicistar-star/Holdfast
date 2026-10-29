CREATE TABLE "indexer_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"last_ledger" integer NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedup_key" text NOT NULL,
	"recipient" text NOT NULL,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_dedup_idx" ON "notification_deliveries" USING btree ("dedup_key");
