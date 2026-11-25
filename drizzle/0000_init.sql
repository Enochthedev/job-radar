CREATE TYPE "public"."actor" AS ENUM('claude', 'wave', 'system');--> statement-breakpoint
CREATE TYPE "public"."app_status" AS ENUM('shortlisted', 'approved', 'applied', 'replied', 'interviewing', 'offer', 'rejected', 'ghosted', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."app_channel" AS ENUM('form', 'email', 'referral');--> statement-breakpoint
CREATE TYPE "public"."draft_kind" AS ENUM('note', 'cold_email', 'follow_up');--> statement-breakpoint
CREATE TYPE "public"."eligibility" AS ENUM('eligible', 'ineligible', 'unknown');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"email" text NOT NULL,
	"label" text,
	"token_enc" text,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_history_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"status" "app_status" DEFAULT 'shortlisted' NOT NULL,
	"channel" "app_channel" DEFAULT 'form' NOT NULL,
	"account_id" integer,
	"recipient_tz" text,
	"applied_at" timestamp with time zone,
	"next_follow_up_at" timestamp with time zone,
	"follow_up_count" integer DEFAULT 0 NOT NULL,
	"sheet_row" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"kind" "draft_kind" NOT NULL,
	"account_id" integer,
	"to_address" text,
	"to_set_by" "actor",
	"subject" text,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" "actor",
	"approved_hash" text,
	"sent_at" timestamp with time zone,
	"gmail_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" "actor" NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"company" text NOT NULL,
	"company_domain" text,
	"title" text NOT NULL,
	"location_raw" text,
	"eligibility" "eligibility" DEFAULT 'unknown' NOT NULL,
	"eligibility_reason" text,
	"remote_scope" text,
	"salary_min" integer,
	"salary_max" integer,
	"currency" text,
	"stack" text[] DEFAULT '{}' NOT NULL,
	"level" text,
	"description" text,
	"posted_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hash" text NOT NULL,
	"rejected" boolean DEFAULT false NOT NULL,
	"reject_reason" text,
	"is_yc" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"job_id" integer PRIMARY KEY NOT NULL,
	"score" integer NOT NULL,
	"reasons" jsonb NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"application_id" integer,
	"subject" text,
	"from_address" text,
	"snippet" text,
	"last_message_at" timestamp with time zone,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"needs_reply" boolean DEFAULT false NOT NULL,
	"job_related" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_email" ON "accounts" USING btree ("provider","email");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_job" ON "applications" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "drafts_app" ON "drafts" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "events_at" ON "events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "events_type" ON "events" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_ext" ON "jobs" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "jobs_hash" ON "jobs" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "jobs_posted" ON "jobs" USING btree ("posted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_acct_gmail" ON "threads" USING btree ("account_id","gmail_thread_id");