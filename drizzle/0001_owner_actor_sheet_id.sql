ALTER TABLE "drafts" ALTER COLUMN "to_set_by" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "drafts" ALTER COLUMN "approved_by" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "actor" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."actor";--> statement-breakpoint
CREATE TYPE "public"."actor" AS ENUM('claude', 'owner', 'system');--> statement-breakpoint
ALTER TABLE "drafts" ALTER COLUMN "to_set_by" SET DATA TYPE "public"."actor" USING "to_set_by"::"public"."actor";--> statement-breakpoint
ALTER TABLE "drafts" ALTER COLUMN "approved_by" SET DATA TYPE "public"."actor" USING "approved_by"::"public"."actor";--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "actor" SET DATA TYPE "public"."actor" USING "actor"::"public"."actor";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "sheet_id" text;