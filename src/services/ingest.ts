import { and, eq, gte, inArray } from "drizzle-orm";
import { db, logEvent } from "../db/client.js";
import { applications, jobs, scores, type NewJob } from "../db/schema.js";
import { classify } from "../filter/classify.js";
import { scoreJob } from "../filter/score.js";
import { llmEligibility } from "../llm.js";
import { loadProfile } from "../profile.js";
import { adapter, adapters } from "../sources/index.js";
import type { RawJob } from "../sources/types.js";
import { companyDomainFrom, jobHash } from "../text.js";

export interface RefreshCounts { source: string; fetched: number; new: number; rejected: number; duplicates: number; error?: string }

const LLM_PER_RUN = 120;

function yearly(n: number | null | undefined, period: RawJob["salaryPeriod"]): number | null {
  if (!n) return null;
  return Math.round(period === "hour" ? n * 2000 : period === "month" ? n * 12 : n);
}

/** Normalise + gate + store one batch from one adapter. */
export async function ingest(raw: RawJob[], sourceName: string): Promise<RefreshCounts> {
  const profile = loadProfile(undefined, true);
  const counts: RefreshCounts = { source: sourceName, fetched: raw.length, new: 0, rejected: 0, duplicates: 0 };
  if (!raw.length) return counts;

  // Dedupe within this batch and against what's stored.
  const bySourceKey = new Map<string, RawJob>();
  for (const r of raw) bySourceKey.set(`${r.source}|${r.externalId}`, r);
  const batch = [...bySourceKey.values()];

  const existing = await db().select({ source: jobs.source, externalId: jobs.externalId }).from(jobs)
    .where(inArray(jobs.source, [...new Set(batch.map((b) => b.source))]));
  const seen = new Set(existing.map((e) => `${e.source}|${e.externalId}`));
  const fresh = batch.filter((b) => !seen.has(`${b.source}|${b.externalId}`));
  if (!fresh.length) return counts;

  // Same role on two boards: company+title hash seen in the last 45 days from another source.
  const hashes = fresh.map((f) => jobHash(f.company, f.title));
  const since = new Date(Date.now() - 45 * 86400_000);
  const dupRows = await db().select({ hash: jobs.hash }).from(jobs)
    .where(and(inArray(jobs.hash, [...new Set(hashes)]), gte(jobs.fetchedAt, since)));
  const dupHashes = new Set(dupRows.map((d) => d.hash));

  const rows: NewJob[] = [];
  for (const r of fresh) {
    const hash = jobHash(r.company, r.title);
    if (dupHashes.has(hash)) { counts.duplicates++; continue; }
    dupHashes.add(hash);
    const c = classify(r, profile);
    if (c.rejectReason) counts.rejected++;
    rows.push({
      source: r.source,
      externalId: r.externalId,
      url: r.url,
      company: r.company.slice(0, 200),
      companyDomain: r.companyDomain ?? companyDomainFrom(r.url),
      title: r.title.slice(0, 300),
      locationRaw: r.locationRaw?.slice(0, 500) ?? null,
      eligibility: c.eligibility,
      eligibilityReason: c.eligibilityReason,
      remoteScope: c.remoteScope,
      // Stored as yearly amounts in the posting's currency.
      salaryMin: yearly(r.salaryMin, r.salaryPeriod),
      salaryMax: yearly(r.salaryMax, r.salaryPeriod),
      currency: r.currency ?? null,
      stack: c.stack,
      level: c.level,
      // Rejected jobs keep their row (for dedupe + stats) but not their text.
      description: c.rejectReason ? null : (r.description ?? "").slice(0, 20000),
      postedAt: r.postedAt && !Number.isNaN(r.postedAt.getTime()) ? r.postedAt : null,
      hash,
      rejected: Boolean(c.rejectReason),
      rejectReason: c.rejectReason,
      isYc: Boolean(r.isYc),
    });
  }

  // Insert in chunks; onConflictDoNothing covers a concurrent run.
  const inserted: { id: number }[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    inserted.push(...(await db().insert(jobs).values(rows.slice(i, i + 200)).onConflictDoNothing().returning({ id: jobs.id })));
  }
  counts.new = inserted.length;

  const meta = new Map(fresh.map((f) => [`${f.source}|${f.externalId}`, f]));
  await resolveUnknowns(inserted.map((i) => i.id));
  await scoreJobs(inserted.map((i) => i.id), meta);
  return counts;
}

/** LLM pass on jobs the regex couldn't decide. Bounded per run to cap spend. */
export async function resolveUnknowns(ids: number[]) {
  if (!ids.length) return;
  if (ids.length > LLM_PER_RUN) { for (let i = 0; i < ids.length; i += LLM_PER_RUN) await resolveUnknowns(ids.slice(i, i + LLM_PER_RUN)); return; }
  const rows = await db().select().from(jobs)
    .where(and(inArray(jobs.id, ids), eq(jobs.eligibility, "unknown"), eq(jobs.rejected, false)))
    .limit(LLM_PER_RUN);
  for (const j of rows) {
    let v;
    try { v = await llmEligibility(j); } catch (e) { console.warn(`[ingest] LLM pass stopped: ${(e as Error).message}`); break; }
    if (!v || v.eligibility === "unknown") continue;
    await db().update(jobs).set({
      eligibility: v.eligibility,
      eligibilityReason: `llm: ${v.reason}`.slice(0, 300),
      remoteScope: v.remote_scope,
      rejected: v.eligibility === "ineligible",
      rejectReason: v.eligibility === "ineligible" ? `eligibility: llm: ${v.reason}`.slice(0, 300) : null,
      description: v.eligibility === "ineligible" ? null : j.description,
    }).where(eq(jobs.id, j.id));
  }
}

export async function scoreJobs(ids?: number[], meta?: Map<string, RawJob>) {
  const profile = loadProfile();
  const watch = new Set(profile.watchlist.map((w) => w.name.toLowerCase()));
  const q = db().select().from(jobs).where(ids ? and(inArray(jobs.id, ids.length ? ids : [-1]), eq(jobs.rejected, false)) : eq(jobs.rejected, false));
  const rows = await q;
  for (const j of rows) {
    const m = meta?.get(`${j.source}|${j.externalId}`);
    const { score, reasons } = scoreJob({
      title: j.title, description: j.description, stack: j.stack,
      salaryMin: j.salaryMin, salaryMax: j.salaryMax, currency: j.currency,
      salaryPeriod: "year",
      postedAt: j.postedAt, remoteScope: j.remoteScope, isYc: j.isYc || Boolean(m?.isYc),
      onWatchlist: watch.has(j.company.toLowerCase()), tags: m?.tags,
    }, profile);
    if (j.eligibility === "unknown") reasons.flag = "eligibility unclear";
    await db().insert(scores).values({ jobId: j.id, score, reasons, scoredAt: new Date() })
      .onConflictDoUpdate({ target: scores.jobId, set: { score, reasons, scoredAt: new Date() } });
  }
  return rows.length;
}

export async function refreshSources(source?: string): Promise<RefreshCounts[]> {
  const list = source ? [adapter(source)].filter((a) => a !== undefined) : adapters();
  if (source && !list.length) throw new Error(`unknown source "${source}"; one of ${adapters().map((a) => a.name).join(", ")}`);
  const results: RefreshCounts[] = [];
  for (const a of list) {
    try {
      results.push(await ingest(await a.fetch(), a.name));
    } catch (e) {
      results.push({ source: a.name, fetched: 0, new: 0, rejected: 0, duplicates: 0, error: (e as Error).message });
    }
  }
  await logEvent("system", "sources.refreshed", { results });
  return results;
}

/**
 * Re-runs the gates on stored jobs with the current rules (after a rules fix or a
 * profile.yaml change). Jobs that become ineligible are rejected; shortlisted
 * applications for them are skipped so Claude never drafts for a role that can't be taken.
 */
export async function reclassifyAll() {
  const profile = loadProfile(undefined, true);
  const rows = await db().select().from(jobs).where(eq(jobs.rejected, false));
  let rejected = 0, toLlm: number[] = [], skipped = 0;
  for (const j of rows) {
    const c = classify({ source: j.source, externalId: j.externalId, url: j.url, company: j.company, title: j.title, locationRaw: j.locationRaw, description: j.description }, profile);
    if (c.rejectReason) {
      await db().update(jobs).set({ rejected: true, rejectReason: c.rejectReason, eligibility: c.eligibility, eligibilityReason: c.eligibilityReason, remoteScope: c.remoteScope, description: null }).where(eq(jobs.id, j.id));
      rejected++;
      const apps = await db().update(applications).set({ status: "skipped", note: `auto-skipped: ${c.rejectReason}`.slice(0, 300), updatedAt: new Date() })
        .where(and(eq(applications.jobId, j.id), eq(applications.status, "shortlisted"))).returning({ id: applications.id });
      for (const a of apps) { skipped++; await logEvent("system", "application.status", { application_id: a.id, to: "skipped", note: c.rejectReason }); }
    } else if (c.eligibility !== j.eligibility && !(j.eligibilityReason ?? "").startsWith("llm:")) {
      await db().update(jobs).set({ eligibility: c.eligibility, eligibilityReason: c.eligibilityReason, remoteScope: c.remoteScope }).where(eq(jobs.id, j.id));
      if (c.eligibility === "unknown") toLlm.push(j.id);
    }
  }
  await resolveUnknowns(toLlm);
  await logEvent("system", "jobs.reclassified", { checked: rows.length, rejected, sent_to_llm: toLlm.length, shortlist_skipped: skipped });
  return { checked: rows.length, rejected, sent_to_llm: toLlm.length, shortlist_skipped: skipped };
}

// Daily: re-run the gates with current rules, then rescore what's left.
export async function rescoreAll() {
  const reclassified = await reclassifyAll();
  const n = await scoreJobs();
  await logEvent("system", "scores.recomputed", { n });
  return { reclassified, scored: n };
}

