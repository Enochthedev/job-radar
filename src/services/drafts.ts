import { and, desc, eq, gte, isNotNull, isNull, sql as dsql } from "drizzle-orm";
import { config } from "../config.js";
import { db, logEvent } from "../db/client.js";
import { accounts, applications, drafts, jobs, threads, type Draft } from "../db/schema.js";
import { sendMessage } from "../google/gmail.js";
import { findAccount } from "../google/oauth.js";
import { loadProfile } from "../profile.js";
import { sha256 } from "../text.js";
import { refuseReason } from "./guardrails.js";
import { draftView, ensureApplication } from "./jobs.js";

type Actor = "claude" | "owner" | "system";
const hashOf = (d: { subject?: string | null; body: string; toAddress?: string | null; accountId?: number | null }) =>
  sha256(JSON.stringify([d.subject ?? "", d.body, d.toAddress ?? "", d.accountId ?? null]));

export async function saveDraft(o: { job_id: number; kind: Draft["kind"]; subject?: string; body: string; account?: string; to?: string }, actor: Actor = "claude") {
  const [job] = await db().select().from(jobs).where(eq(jobs.id, o.job_id));
  if (!job) throw new Error(`job ${o.job_id} not found`);
  const acct = o.account ? await findAccount(o.account) : undefined;
  if (o.account && !acct) throw new Error(`no connected account matches "${o.account}"; call list_accounts`);
  if (o.kind !== "note" && !o.subject) throw new Error("emails need a subject");
  const app = await ensureApplication(job.id);
  const channel = o.kind === "note" ? app.channel : "email";
  await db().update(applications).set({ channel, accountId: acct?.id ?? app.accountId, updatedAt: new Date() }).where(eq(applications.id, app.id));
  const toAddress = o.to?.trim().toLowerCase() || null;
  const values = { applicationId: app.id, kind: o.kind, accountId: acct?.id ?? app.accountId ?? null, toAddress, toSetBy: toAddress ? actor : null, subject: o.subject ?? null, body: o.body };
  const [d] = await db().insert(drafts).values({ ...values, contentHash: hashOf(values) }).returning();
  await logEvent(actor, "draft.saved", { draft_id: d.id, application_id: app.id, kind: o.kind });
  return { draft_id: d.id, application_id: app.id, needs_approval: o.kind !== "note" };
}

/** The owner edits a draft (sheet or dashboard). Any edit after approval voids the approval via the hash. */
export async function editDraft(id: number, patch: { subject?: string | null; body?: string; to?: string | null; account?: string }, actor: Actor) {
  const [d] = await db().select().from(drafts).where(eq(drafts.id, id));
  if (!d) throw new Error(`draft ${id} not found`);
  if (d.sentAt) throw new Error("draft already sent");
  const acct = patch.account ? await findAccount(patch.account) : undefined;
  const next = {
    subject: patch.subject !== undefined ? patch.subject : d.subject,
    body: patch.body ?? d.body,
    toAddress: patch.to !== undefined ? (patch.to?.trim().toLowerCase() || null) : d.toAddress,
    accountId: acct?.id ?? d.accountId,
  };
  const toSetBy = patch.to !== undefined && next.toAddress !== d.toAddress ? actor : d.toSetBy;
  const contentHash = hashOf(next);
  if (contentHash === d.contentHash && toSetBy === d.toSetBy) return d;
  const [row] = await db().update(drafts).set({ ...next, toSetBy, contentHash, updatedAt: new Date() }).where(eq(drafts.id, id)).returning();
  await logEvent(actor, "draft.edited", { draft_id: id, approval_voided: Boolean(d.approvedAt) });
  return row;
}

/** Only callable from the dashboard API and the sheet poller — never over MCP. */
export async function approveDraft(id: number, source: "sheet" | "dashboard", at = new Date()) {
  const [d] = await db().select().from(drafts).where(eq(drafts.id, id));
  if (!d) throw new Error(`draft ${id} not found`);
  if (d.sentAt) throw new Error("draft already sent");
  const [row] = await db().update(drafts).set({ approvedAt: at, approvedBy: "owner", approvedHash: d.contentHash }).where(eq(drafts.id, id)).returning();
  const [app] = await db().select().from(applications).where(eq(applications.id, d.applicationId));
  if (app && app.status === "shortlisted") await db().update(applications).set({ status: "approved", updatedAt: new Date() }).where(eq(applications.id, app.id));
  await logEvent("owner", "draft.approved", { draft_id: id, application_id: d.applicationId, source, content_hash: d.contentHash });
  return draftView(row);
}

/** Midnight today in the home timezone, as a UTC instant. */
export function startOfDayIn(tz: string, now = new Date()): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = off.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const minutes = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - minutes * 60_000);
}

export async function sendEmail(draftId: number, actor: Actor = "claude") {
  const c = config();
  const [d] = await db().select().from(drafts).where(eq(drafts.id, draftId));
  if (!d) throw new Error(`draft ${draftId} not found`);
  if (d.kind === "note") throw new Error("notes are for application forms; Claude fills the form and the owner submits it");
  const [app] = await db().select().from(applications).where(eq(applications.id, d.applicationId));
  const [job] = await db().select().from(jobs).where(eq(jobs.id, app.jobId));
  const [acct] = d.accountId ? await db().select().from(accounts).where(eq(accounts.id, d.accountId)) : [];
  const [{ n: sentToday }] = acct
    ? await db().select({ n: dsql<number>`count(*)::int` }).from(drafts).where(and(eq(drafts.accountId, acct.id), gte(drafts.sentAt, startOfDayIn(c.TZ_HOME ?? loadProfile().home.timezone))))
    : [{ n: 0 }];

  const reason = refuseReason({
    sendingEnabled: c.SENDING_ENABLED, draft: d, accountStatus: acct?.status ?? null, sentTodayByAccount: sentToday,
    maxPerDay: c.MAX_SENDS_PER_ACCOUNT_PER_DAY, followUpCount: app.followUpCount, maxFollowUps: loadProfile().max_follow_ups,
    companyDomain: job.companyDomain, recipientTz: app.recipientTz, now: new Date(),
  });
  if (reason) {
    await logEvent(actor, "send.refused", { draft_id: draftId, reason });
    throw new Error(`send refused: ${reason}`);
  }

  // Claim the draft atomically so two callers can't both send it.
  const claimed = await db().update(drafts).set({ sentAt: new Date() })
    .where(and(eq(drafts.id, draftId), isNull(drafts.sentAt), isNotNull(drafts.approvedAt), eq(drafts.approvedHash, d.contentHash)))
    .returning({ id: drafts.id });
  if (!claimed.length) throw new Error("send refused: draft changed or was sent concurrently");

  // Follow-ups go into the existing thread.
  const [prior] = d.kind === "follow_up"
    ? await db().select().from(threads).where(and(eq(threads.applicationId, app.id), eq(threads.accountId, acct!.id))).orderBy(desc(threads.lastMessageAt)).limit(1)
    : [];
  let sent: { id: string; threadId: string };
  try {
    sent = await sendMessage(acct!, {
      from: acct!.email, to: d.toAddress!, subject: d.subject ?? `${job.title} at ${job.company}`, body: d.body,
      threadId: prior?.gmailThreadId ?? null,
    });
  } catch (err) {
    await db().update(drafts).set({ sentAt: null }).where(eq(drafts.id, draftId));
    await logEvent("system", "send.failed", { draft_id: draftId, error: (err as Error).message.slice(0, 300) });
    throw err;
  }

  await db().update(drafts).set({ gmailMessageId: sent.id }).where(eq(drafts.id, draftId));
  await db().insert(threads).values({
    accountId: acct!.id, gmailThreadId: sent.threadId, applicationId: app.id, subject: d.subject, fromAddress: acct!.email,
    lastMessageAt: new Date(), direction: "outbound", needsReply: false, jobRelated: true,
  }).onConflictDoUpdate({ target: [threads.accountId, threads.gmailThreadId], set: { lastMessageAt: new Date(), direction: "outbound", applicationId: app.id } });

  const days = loadProfile().follow_up_days;
  if (d.kind === "follow_up") {
    const count = app.followUpCount + 1;
    const next = days[count] !== undefined && app.appliedAt ? new Date(app.appliedAt.getTime() + days[count] * 86400_000) : null;
    await db().update(applications).set({ followUpCount: count, nextFollowUpAt: next, updatedAt: new Date() }).where(eq(applications.id, app.id));
  } else {
    await db().update(applications).set({
      status: "applied", channel: "email", accountId: acct!.id, appliedAt: app.appliedAt ?? new Date(),
      nextFollowUpAt: new Date(Date.now() + days[0] * 86400_000), updatedAt: new Date(),
    }).where(eq(applications.id, app.id));
  }
  await logEvent(actor, "email.sent", {
    draft_id: draftId, application_id: app.id, account: acct!.email, to: d.toAddress, gmail_message_id: sent.id,
    approved_at: d.approvedAt, approved_hash: d.approvedHash,
  });
  return { gmail_message_id: sent.id, thread_id: sent.threadId, from: acct!.email, to: d.toAddress };
}
