import { and, desc, eq, gte, ilike, isNull, lte, ne, or, sql as dsql, type SQL } from "drizzle-orm";
import { db, logEvent } from "../db/client.js";
import { applications, drafts, jobs, scores, type Application } from "../db/schema.js";
import { loadProfile } from "../profile.js";
import { fetchAshby, fetchGreenhouse, fetchLever } from "../sources/ats.js";
import { parseSalaryText } from "../sources/salary.js";
import type { RawJob } from "../sources/types.js";
import { companyDomainFrom, decodeEntities, getText, htmlToText } from "../text.js";
import { ingest } from "./ingest.js";

export type AppStatus = Application["status"];
const ACTIVE: AppStatus[] = ["approved", "applied", "replied", "interviewing"];

function jobView(j: typeof jobs.$inferSelect, s?: { score: number; reasons: unknown } | null, withDescription = false) {
  return {
    id: j.id, source: j.source, url: j.url, company: j.company, company_domain: j.companyDomain, title: j.title,
    location: j.locationRaw, eligibility: j.eligibility, eligibility_reason: j.eligibilityReason, remote_scope: j.remoteScope,
    salary: j.salaryMin || j.salaryMax ? { min: j.salaryMin, max: j.salaryMax, currency: j.currency, period: "year" } : null,
    stack: j.stack, level: j.level, posted_at: j.postedAt, fetched_at: j.fetchedAt, is_yc: j.isYc,
    score: s?.score ?? null, reasons: s?.reasons ?? null,
    ...(j.rejected ? { rejected: true, reject_reason: j.rejectReason } : {}),
    ...(withDescription ? { description: j.description } : {}),
    ...(j.source === "remoteok" ? { credit: "via RemoteOK (remoteok.com)" } : {}),
  };
}

export async function searchJobs(o: { query?: string; min_score?: number; eligibility?: "eligible" | "ineligible" | "unknown"; since?: string; limit?: number; include_rejected?: boolean }) {
  const where: SQL[] = [];
  if (!o.include_rejected) where.push(eq(jobs.rejected, false));
  if (o.eligibility) where.push(eq(jobs.eligibility, o.eligibility));
  if (o.min_score !== undefined) where.push(gte(scores.score, o.min_score));
  if (o.since) where.push(gte(dsql`coalesce(${jobs.postedAt}, ${jobs.fetchedAt})`, dsql`${new Date(o.since).toISOString()}::timestamptz`));
  if (o.query) {
    const q = `%${o.query}%`;
    where.push(or(ilike(jobs.title, q), ilike(jobs.company, q), ilike(jobs.description, q))!);
  }
  const rows = await db().select({ j: jobs, s: scores }).from(jobs)
    .leftJoin(scores, eq(scores.jobId, jobs.id))
    .where(and(...where))
    .orderBy(desc(dsql`coalesce(${scores.score}, -1)`), desc(jobs.postedAt))
    .limit(Math.min(o.limit ?? 20, 100));
  return rows.map((r) => jobView(r.j, r.s));
}

export async function getJob(id: number) {
  const [r] = await db().select({ j: jobs, s: scores }).from(jobs).leftJoin(scores, eq(scores.jobId, jobs.id)).where(eq(jobs.id, id));
  if (!r) return null;
  const [app] = await db().select().from(applications).where(eq(applications.jobId, id));
  const ds = app ? await db().select().from(drafts).where(eq(drafts.applicationId, app.id)).orderBy(desc(drafts.id)) : [];
  return { ...jobView(r.j, r.s, true), application: app ? { ...app, drafts: ds.map(draftView) } : null };
}

export function draftView(d: typeof drafts.$inferSelect) {
  return {
    id: d.id, application_id: d.applicationId, kind: d.kind, account_id: d.accountId, to: d.toAddress, subject: d.subject, body: d.body,
    approved_at: d.approvedAt, approved_by: d.approvedBy, approval_valid: Boolean(d.approvedAt && d.approvedHash === d.contentHash),
    sent_at: d.sentAt, created_at: d.createdAt,
  };
}

/** Parse a job page: known ATS APIs first, then schema.org JobPosting JSON-LD, then <title>. */
export async function parseJobUrl(url: string): Promise<RawJob> {
  const u = new URL(url);
  const gh = u.hostname.match(/greenhouse\.io$/) && url.match(/\/([^/]+)\/jobs\/(\d+)/);
  if (gh) { const all = await fetchGreenhouse({ name: gh[1], ats: "greenhouse", board: gh[1] }); const f = all.find((j) => j.externalId.endsWith(`:${gh[2]}`)); if (f) return { ...f, onWatchlist: false }; }
  const lv = u.hostname === "jobs.lever.co" && url.match(/lever\.co\/([^/]+)\/([0-9a-f-]{36})/);
  if (lv) { const all = await fetchLever({ name: lv[1], ats: "lever", board: lv[1] }); const f = all.find((j) => j.externalId.endsWith(`:${lv[2]}`)); if (f) return { ...f, onWatchlist: false }; }
  const ab = u.hostname === "jobs.ashbyhq.com" && url.match(/ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/);
  if (ab) { const all = await fetchAshby({ name: ab[1], ats: "ashby", board: ab[1] }); const f = all.find((j) => j.externalId.endsWith(`:${ab[2]}`)); if (f) return { ...f, onWatchlist: false }; }

  const html = await getText(url);
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      const list = Array.isArray(data) ? data : data["@graph"] ?? [data];
      const jp = list.find((x: { "@type"?: string | string[] }) => [x["@type"]].flat().includes("JobPosting"));
      if (!jp) continue;
      const loc = [jp.applicantLocationRequirements, jp.jobLocation].flat().filter(Boolean)
        .map((l: { name?: string; address?: { addressCountry?: string | { name?: string }; addressLocality?: string } }) =>
          l.name ?? [l.address?.addressLocality, typeof l.address?.addressCountry === "string" ? l.address.addressCountry : l.address?.addressCountry?.name].filter(Boolean).join(", "))
        .filter(Boolean).join("; ");
      const sal = jp.baseSalary?.value;
      return {
        source: "manual", externalId: url, url, title: decodeEntities(jp.title ?? ""),
        company: decodeEntities(jp.hiringOrganization?.name ?? u.hostname),
        companyDomain: companyDomainFrom(jp.hiringOrganization?.sameAs ?? jp.hiringOrganization?.url) ?? companyDomainFrom(url),
        locationRaw: [jp.jobLocationType === "TELECOMMUTE" ? "Remote" : null, loc].filter(Boolean).join(" · ") || null,
        salaryMin: sal?.minValue ?? sal?.value ?? null, salaryMax: sal?.maxValue ?? null, currency: jp.baseSalary?.currency ?? null,
        salaryPeriod: /HOUR/i.test(sal?.unitText ?? "") ? "hour" : /MONTH/i.test(sal?.unitText ?? "") ? "month" : sal ? "year" : null,
        description: htmlToText(jp.description), postedAt: jp.datePosted ? new Date(jp.datePosted) : null,
      };
    } catch { /* not JSON we understand */ }
  }
  const title = decodeEntities(html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ?? html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? url).trim();
  const site = html.match(/<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i)?.[1];
  const body = htmlToText(html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html).slice(0, 20000);
  return { source: "manual", externalId: url, url, title, company: decodeEntities(site ?? u.hostname.replace(/^www\.|^jobs\.|^careers\./, "")), companyDomain: companyDomainFrom(url), description: body, ...parseSalaryText(body.match(/[$€£]\s?\d[\d,.]*k?\s?[-–]\s?[$€£]?\s?\d[\d,.]*k?/i)?.[0]) };
}

export async function addJob(url: string, actor: "claude" | "owner" = "claude") {
  const raw = await parseJobUrl(url);
  raw.source = "manual"; raw.externalId = url;
  const counts = await ingest([raw], "manual");
  const [row] = await db().select({ id: jobs.id }).from(jobs).where(and(eq(jobs.source, "manual"), eq(jobs.externalId, url)));
  await logEvent(actor, "job.added", { url, counts });
  if (!row) {
    // Same company+title already on file from a board.
    const dupe = await searchJobs({ query: raw.title, limit: 1, include_rejected: true });
    return { duplicate_of: dupe[0] ?? null, parsed: { title: raw.title, company: raw.company } };
  }
  return getJob(row.id);
}

export async function ensureApplication(jobId: number, status: AppStatus = "shortlisted"): Promise<Application> {
  const [existing] = await db().select().from(applications).where(eq(applications.jobId, jobId));
  if (existing) return existing;
  const [created] = await db().insert(applications).values({ jobId, status }).onConflictDoNothing().returning();
  return created ?? (await db().select().from(applications).where(eq(applications.jobId, jobId)))[0];
}

/** Today's top roles not yet seen. Marks them shortlisted. */
export async function shortlist(limit?: number) {
  const p = loadProfile();
  const n = Math.min(limit ?? p.shortlist.size, 50);
  const since = new Date(Date.now() - 21 * 86400_000);
  const rows = await db().select({ j: jobs, s: scores }).from(jobs)
    .innerJoin(scores, eq(scores.jobId, jobs.id))
    .leftJoin(applications, eq(applications.jobId, jobs.id))
    .where(and(
      eq(jobs.rejected, false), ne(jobs.eligibility, "ineligible"), isNull(applications.id),
      gte(scores.score, p.shortlist.min_score), gte(dsql`coalesce(${jobs.postedAt}, ${jobs.fetchedAt})`, dsql`${since.toISOString()}::timestamptz`),
    ))
    .orderBy(desc(scores.score), desc(jobs.postedAt))
    .limit(n);
  const out = [];
  for (const r of rows) {
    const app = await ensureApplication(r.j.id, "shortlisted");
    out.push({ ...jobView(r.j, r.s, true), application_id: app.id });
  }
  await logEvent("system", "shortlist.created", { job_ids: rows.map((r) => r.j.id) });
  return out;
}

export async function updateStatus(applicationId: number, status: AppStatus, note: string | undefined, actor: "claude" | "owner" | "system") {
  const [app] = await db().select().from(applications).where(eq(applications.id, applicationId));
  if (!app) throw new Error(`application ${applicationId} not found`);
  if (status === "approved" && actor !== "owner") throw new Error("only the owner can approve; set Decision=Apply in the sheet or approve on the dashboard");
  const patch: Partial<Application> = { status, updatedAt: new Date(), ...(note ? { note } : {}) };
  if (status === "applied" && !app.appliedAt) {
    patch.appliedAt = new Date();
    patch.nextFollowUpAt = new Date(Date.now() + loadProfile().follow_up_days[0] * 86400_000);
  }
  if (["replied", "interviewing", "offer", "rejected", "ghosted", "skipped"].includes(status)) patch.nextFollowUpAt = null;
  const [row] = await db().update(applications).set(patch).where(eq(applications.id, applicationId)).returning();
  await logEvent(actor, "application.status", { application_id: applicationId, from: app.status, to: status, note });
  return row;
}

export async function followUpsDue() {
  const p = loadProfile();
  const rows = await db().select({ a: applications, j: jobs }).from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(and(eq(applications.status, "applied"), lte(applications.nextFollowUpAt, new Date()), dsql`${applications.followUpCount} < ${p.max_follow_ups}`));
  return rows.map((r) => ({
    application_id: r.a.id, job_id: r.j.id, company: r.j.company, title: r.j.title, channel: r.a.channel,
    applied_at: r.a.appliedAt, follow_ups_sent: r.a.followUpCount, follow_up_number: r.a.followUpCount + 1,
    days_since_applied: r.a.appliedAt ? Math.floor((Date.now() - r.a.appliedAt.getTime()) / 86400_000) : null,
  }));
}

export async function stats(range?: string) {
  const days = Number(range?.match(/^(\d+)d$/)?.[1] ?? 30);
  const since = new Date(Date.now() - days * 86400_000);
  const byStatus = await db().select({ status: applications.status, n: dsql<number>`count(*)::int` }).from(applications)
    .where(gte(applications.createdAt, since)).groupBy(applications.status);
  const bySource = await db().select({
    source: jobs.source,
    fetched: dsql<number>`count(*)::int`,
    passed: dsql<number>`count(*) filter (where not ${jobs.rejected})::int`,
    applied: dsql<number>`count(${applications.id}) filter (where ${applications.appliedAt} is not null)::int`,
    replied: dsql<number>`count(${applications.id}) filter (where ${applications.status} in ('replied','interviewing','offer','rejected'))::int`,
    interviewing: dsql<number>`count(${applications.id}) filter (where ${applications.status} in ('interviewing','offer'))::int`,
  }).from(jobs).leftJoin(applications, eq(applications.jobId, jobs.id)).where(gte(jobs.fetchedAt, since)).groupBy(jobs.source);
  const s = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
  const applied = ["applied", "replied", "interviewing", "offer", "rejected", "ghosted"].reduce((a, k) => a + (s[k] ?? 0), 0);
  const replied = ["replied", "interviewing", "offer", "rejected"].reduce((a, k) => a + (s[k] ?? 0), 0);
  const interviews = (s.interviewing ?? 0) + (s.offer ?? 0);
  const sent = await db().select({ n: dsql<number>`count(*)::int` }).from(drafts).where(gte(drafts.sentAt, since));
  return {
    range_days: days, by_status: s, applied, replied, interviews,
    reply_rate: applied ? +(replied / applied).toFixed(3) : null,
    interview_rate: applied ? +(interviews / applied).toFixed(3) : null,
    emails_sent: sent[0]?.n ?? 0, by_source: bySource,
  };
}

export const ACTIVE_STATUSES = ACTIVE;
