import {
  pgTable, serial, text, integer, timestamp, jsonb, uniqueIndex, index, pgEnum, boolean,
} from "drizzle-orm/pg-core";

export const eligibilityEnum = pgEnum("eligibility", ["eligible", "ineligible", "unknown"]);
export const appStatusEnum = pgEnum("app_status", [
  "shortlisted", "approved", "applied", "replied", "interviewing", "offer", "rejected", "ghosted", "skipped",
]);
export const channelEnum = pgEnum("app_channel", ["form", "email", "referral"]);
export const draftKindEnum = pgEnum("draft_kind", ["note", "cold_email", "follow_up"]);
export const actorEnum = pgEnum("actor", ["claude", "owner", "system"]);

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  externalId: text("external_id").notNull(),
  url: text("url").notNull(),
  company: text("company").notNull(),
  companyDomain: text("company_domain"),
  title: text("title").notNull(),
  locationRaw: text("location_raw"),
  eligibility: eligibilityEnum("eligibility").notNull().default("unknown"),
  eligibilityReason: text("eligibility_reason"),
  remoteScope: text("remote_scope"),
  salaryMin: integer("salary_min"),
  salaryMax: integer("salary_max"),
  currency: text("currency"),
  stack: text("stack").array().notNull().default([]),
  level: text("level"),
  description: text("description"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  hash: text("hash").notNull(),
  rejected: boolean("rejected").notNull().default(false),
  rejectReason: text("reject_reason"),
  isYc: boolean("is_yc").notNull().default(false),
}, (t) => [
  uniqueIndex("jobs_source_ext").on(t.source, t.externalId),
  index("jobs_hash").on(t.hash),
  index("jobs_posted").on(t.postedAt),
]);

export const scores = pgTable("scores", {
  jobId: integer("job_id").primaryKey().references(() => jobs.id, { onDelete: "cascade" }),
  score: integer("score").notNull(),
  reasons: jsonb("reasons").$type<Record<string, number | string>>().notNull(),
  scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull().default("google"),
  email: text("email").notNull(),
  label: text("label"),
  tokenEnc: text("token_enc"),
  scopes: text("scopes").array().notNull().default([]),
  status: text("status").notNull().default("connected"), // connected | expired | error
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastHistoryId: text("last_history_id"),
  sheetId: text("sheet_id"), // tracker spreadsheet Job Radar created in this account
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("accounts_provider_email").on(t.provider, t.email)]);

export const applications = pgTable("applications", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  status: appStatusEnum("status").notNull().default("shortlisted"),
  channel: channelEnum("channel").notNull().default("form"),
  accountId: integer("account_id").references(() => accounts.id),
  recipientTz: text("recipient_tz"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
  followUpCount: integer("follow_up_count").notNull().default(0),
  sheetRow: integer("sheet_row"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("applications_job").on(t.jobId)]);

export const drafts = pgTable("drafts", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  kind: draftKindEnum("kind").notNull(),
  accountId: integer("account_id").references(() => accounts.id),
  toAddress: text("to_address"),
  toSetBy: actorEnum("to_set_by"),
  subject: text("subject"),
  body: text("body").notNull(),
  contentHash: text("content_hash").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: actorEnum("approved_by"),
  approvedHash: text("approved_hash"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  gmailMessageId: text("gmail_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("drafts_app").on(t.applicationId)]);

export const threads = pgTable("threads", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  gmailThreadId: text("gmail_thread_id").notNull(),
  applicationId: integer("application_id").references(() => applications.id, { onDelete: "set null" }),
  subject: text("subject"),
  fromAddress: text("from_address"),
  snippet: text("snippet"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  direction: text("direction").notNull().default("inbound"), // inbound | outbound
  needsReply: boolean("needs_reply").notNull().default(false),
  jobRelated: boolean("job_related").notNull().default(false),
}, (t) => [uniqueIndex("threads_acct_gmail").on(t.accountId, t.gmailThreadId)]);

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actor: actorEnum("actor").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [index("events_at").on(t.at), index("events_type").on(t.type)]);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Application = typeof applications.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type Account = typeof accounts.$inferSelect;
