import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db, logEvent } from "../db/client.js";
import { accounts, applications, jobs, threads, type Account } from "../db/schema.js";
import { createEvent } from "../google/calendar.js";
import { getMessage, listMessageIds, type ParsedMessage } from "../google/gmail.js";
import { AccountExpiredError, primaryAccount } from "../google/oauth.js";
import { llmMeeting } from "../llm.js";
import { updateStatus } from "./jobs.js";

const JOB_WORDS = /\b(application|applied|interview|position|role|candidate|candidacy|recruit(er|ing)?|hiring|offer|opportunit(y|ies)|resume|cv|assessment|take[- ]home|screening|next steps)\b/i;
const MEETING_WORDS = /\b(interview|call|chat|meet(ing)?|schedule[d]?|calendar|zoom|google meet|teams|available|availability)\b/i;
const ATS_SENDERS = /greenhouse|lever\.co|ashbyhq|workable|smartrecruiters|bamboohr|recruitee|teamtailor|breezy|jazzhr|rippling|myworkday/i;
const MATCHABLE = ["approved", "applied", "replied", "interviewing"] as const;

interface Candidate { appId: number; status: string; company: string; domain: string | null }

function matchByCompany(m: ParsedMessage, cands: Candidate[]): Candidate | undefined {
  const domain = m.fromEmail.split("@")[1] ?? "";
  const byDomain = cands.find((c) => c.domain && (domain === c.domain || domain.endsWith(`.${c.domain}`)));
  if (byDomain) return byDomain;
  // ATS mail comes from the ATS's domain; fall back to the company name in sender or subject.
  if (ATS_SENDERS.test(domain) || JOB_WORDS.test(m.subject)) {
    const hay = `${m.from} ${m.subject}`.toLowerCase();
    return cands.find((c) => c.company.length >= 4 && hay.includes(c.company.toLowerCase()));
  }
}

export interface InboxItem {
  account: string; thread_id: string; application_id: number | null; company: string | null; title: string | null;
  from: string; subject: string; snippet: string; received_at: Date; status_change?: string; calendar_event?: string;
}

/** Reads one account's recent inbound mail, links threads to applications, flips statuses. */
export async function syncAccount(acct: Account, opts: { since?: Date; dryRun?: boolean } = {}): Promise<{ matched: InboxItem[]; unmatched: InboxItem[] }> {
  const since = opts.since ?? acct.lastSyncAt ?? new Date(Date.now() - 14 * 86400_000);
  const q = `after:${Math.floor(since.getTime() / 1000) - 600} -in:sent -in:chats -category:promotions -category:social`;
  const ids = await listMessageIds(acct, q, 150);

  const cands: Candidate[] = (await db().select({ appId: applications.id, status: applications.status, company: jobs.company, domain: jobs.companyDomain })
    .from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(inArray(applications.status, [...MATCHABLE])));
  const known = new Map((await db().select().from(threads).where(eq(threads.accountId, acct.id))).map((t) => [t.gmailThreadId, t]));
  const titles = new Map((await db().select({ id: applications.id, company: jobs.company, title: jobs.title }).from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId))).map((r) => [r.id, r]));

  const matched: InboxItem[] = [], unmatched: InboxItem[] = [];
  for (const { id } of ids.reverse()) {
    const m = await getMessage(acct, id);
    if (m.isSent || m.fromEmail === acct.email) continue;
    const thread = known.get(m.threadId);
    let appId = thread?.applicationId ?? null;
    let how = appId ? "thread" : null;
    if (!appId) { const c = matchByCompany(m, cands); if (c) { appId = c.appId; how = "company"; } }
    const jobRelated = Boolean(appId) || JOB_WORDS.test(`${m.subject} ${m.text.slice(0, 1500)}`);
    if (!jobRelated) continue;

    const meta = appId ? titles.get(appId) : undefined;
    const item: InboxItem = {
      account: acct.email, thread_id: m.threadId, application_id: appId, company: meta?.company ?? null, title: meta?.title ?? null,
      from: m.from, subject: m.subject, snippet: m.snippet, received_at: m.date,
    };

    if (!opts.dryRun) {
      await db().insert(threads).values({
        accountId: acct.id, gmailThreadId: m.threadId, applicationId: appId, subject: m.subject, fromAddress: m.fromEmail,
        snippet: m.snippet, lastMessageAt: m.date, direction: "inbound", needsReply: true, jobRelated,
      }).onConflictDoUpdate({
        target: [threads.accountId, threads.gmailThreadId],
        set: { lastMessageAt: m.date, direction: "inbound", needsReply: true, snippet: m.snippet, fromAddress: m.fromEmail, ...(appId ? { applicationId: appId } : {}) },
      });
      if (appId) {
        const cand = cands.find((c) => c.appId === appId);
        const status = cand?.status ?? (await db().select({ s: applications.status }).from(applications).where(eq(applications.id, appId)))[0]?.s;
        if (status === "applied" || status === "approved") {
          await updateStatus(appId, "replied", `reply from ${m.fromEmail} (matched by ${how})`, "system");
          item.status_change = "replied";
          if (cand) cand.status = "replied";
        }
        if (MEETING_WORDS.test(`${m.subject} ${m.text}`) || /unfortunately|not (be )?moving forward|other candidates/i.test(m.text)) {
          const info = await llmMeeting({ from: m.from, subject: m.subject, text: m.text, receivedAt: m.date });
          if (info?.is_rejection) {
            await updateStatus(appId, "rejected", `rejection from ${m.fromEmail}`, "system");
            item.status_change = "rejected";
          } else if (info?.has_meeting && info.start_iso && !Number.isNaN(Date.parse(info.start_iso)) && Date.parse(info.start_iso) > Date.now()) {
            const cal = await primaryAccount();
            if (cal?.scopes.some((s) => s.endsWith("/calendar.events"))) {
              const ev = await createEvent(cal, {
                summary: info.title ?? `Interview: ${meta?.company ?? m.fromEmail}`,
                start: new Date(info.start_iso), minutes: info.duration_minutes ?? 30,
                location: info.video_link ?? undefined,
                description: `Job Radar · application #${appId}${meta ? ` · ${meta.title} at ${meta.company}` : ""}\nFrom: ${m.from}\nSubject: ${m.subject}`,
              });
              item.calendar_event = ev.htmlLink;
              await logEvent("system", "calendar.event_created", { application_id: appId, event_id: ev.id, start: info.start_iso });
            }
            await updateStatus(appId, "interviewing", `meeting ${info.start_iso}`, "system");
            item.status_change = "interviewing";
          }
        }
      }
    }
    (appId ? matched : unmatched).push(item);
  }
  if (!opts.dryRun) await db().update(accounts).set({ lastSyncAt: new Date() }).where(eq(accounts.id, acct.id));
  return { matched, unmatched };
}

export async function syncAllInboxes() {
  const accts = await db().select().from(accounts).where(and(eq(accounts.provider, "google"), eq(accounts.status, "connected")));
  const out: Record<string, { matched: number; unmatched: number; error?: string }> = {};
  for (const a of accts) {
    try {
      const r = await syncAccount(a);
      out[a.email] = { matched: r.matched.length, unmatched: r.unmatched.length };
    } catch (e) {
      out[a.email] = { matched: 0, unmatched: 0, error: e instanceof AccountExpiredError ? "expired: reconnect" : (e as Error).message.slice(0, 200) };
    }
  }
  await logEvent("system", "inbox.synced", out);
  return out;
}

/** For the inbox_digest tool: what's come in, from the stored thread index (kept fresh every 15 min). */
export async function inboxDigest(o: { since?: string; account?: string }) {
  const since = o.since ? new Date(o.since) : new Date(Date.now() - 24 * 3600_000);
  const rows = await db().select({ t: threads, a: accounts }).from(threads).innerJoin(accounts, eq(accounts.id, threads.accountId))
    .where(and(gte(threads.lastMessageAt, since), eq(threads.direction, "inbound"), eq(threads.jobRelated, true)))
    .orderBy(desc(threads.lastMessageAt)).limit(100);
  const filtered = o.account ? rows.filter((r) => r.a.email === o.account!.toLowerCase() || r.a.label?.toLowerCase() === o.account!.toLowerCase()) : rows;
  const appIds = [...new Set(filtered.map((r) => r.t.applicationId).filter((x): x is number => x !== null))];
  const apps = appIds.length ? await db().select({ id: applications.id, status: applications.status, company: jobs.company, title: jobs.title })
    .from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId)).where(inArray(applications.id, appIds)) : [];
  const byId = new Map(apps.map((a) => [a.id, a]));
  const view = (r: (typeof filtered)[number]) => ({
    account: r.a.email, thread_id: r.t.gmailThreadId, from: r.t.fromAddress, subject: r.t.subject, snippet: r.t.snippet,
    received_at: r.t.lastMessageAt, needs_reply: r.t.needsReply,
    ...(r.t.applicationId ? { application: byId.get(r.t.applicationId) ?? { id: r.t.applicationId } } : {}),
  });
  return {
    since,
    replies: filtered.filter((r) => r.t.applicationId).map(view),
    unmatched_job_mail: filtered.filter((r) => !r.t.applicationId).map(view),
  };
}
