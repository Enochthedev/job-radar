import { and, desc, eq, inArray } from "drizzle-orm";
import { config } from "../config.js";
import { db, logEvent } from "../db/client.js";
import { accounts, applications, drafts, jobs, scores } from "../db/schema.js";
import { primaryAccount } from "../google/oauth.js";
import { appendRows, ensureTab, readRange, writeRange } from "../google/sheets.js";
import { addJob, updateStatus } from "./jobs.js";
import { approveDraft, editDraft } from "./drafts.js";

export const TAB = "Shortlist";
export const HEADER = ["App ID", "Added", "Company", "Role", "Score", "Eligibility", "Link", "Channel", "Account", "To", "Subject", "Draft", "Decision", "Status", "Draft ID", "Approved", "Notes"];
const col = (name: string) => HEADER.indexOf(name);
const RANGE = `${TAB}!A1:Q2000`;
const SYNCED_STATUSES = ["shortlisted", "approved", "applied", "replied", "interviewing", "offer", "rejected", "ghosted", "skipped"] as const;

async function sheetCtx() {
  const id = config().JOB_TRACKER_SHEET_ID;
  if (!id) throw new Error("JOB_TRACKER_SHEET_ID is not set");
  const acct = await primaryAccount();
  if (!acct) throw new Error("no connected Google account with Sheets access; connect the primary account on the dashboard");
  await ensureTab(acct, id, TAB, HEADER);
  return { id, acct };
}

async function latestDrafts(appIds: number[]) {
  if (!appIds.length) return new Map<number, typeof drafts.$inferSelect>();
  const rows = await db().select().from(drafts).where(inArray(drafts.applicationId, appIds)).orderBy(desc(drafts.id));
  const m = new Map<number, typeof drafts.$inferSelect>();
  for (const d of rows) if (!m.has(d.applicationId)) m.set(d.applicationId, d);
  return m;
}

/** Push: one row per application, keyed by App ID (so sorting the sheet is safe). */
export async function syncSheet() {
  const { id, acct } = await sheetCtx();
  const values = await readRange(acct, id, RANGE);
  const rowOf = new Map<number, number>();
  values.slice(1).forEach((r, i) => { const n = Number(r[0]); if (n) rowOf.set(n, i + 2); });

  const apps = await db().select({ a: applications, j: jobs, s: scores }).from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId)).leftJoin(scores, eq(scores.jobId, jobs.id))
    .where(inArray(applications.status, [...SYNCED_STATUSES]));
  const ds = await latestDrafts(apps.map((x) => x.a.id));
  const accts = new Map((await db().select().from(accounts)).map((a) => [a.id, a.email]));

  let added = 0, updated = 0;
  const toAppend: (string | number | null)[][] = [];
  for (const { a, j, s } of apps) {
    const d = ds.get(a.id);
    const row = rowOf.get(a.id);
    if (!row) {
      toAppend.push([
        a.id, a.createdAt.toISOString().slice(0, 10), j.company, j.title, s?.score ?? "", j.eligibility, j.url, a.channel,
        accts.get(d?.accountId ?? a.accountId ?? -1) ?? "", d?.toAddress ?? "", d?.subject ?? "", d?.body ?? "",
        a.status === "skipped" ? "Skip" : "", a.status, d?.id ?? "", d?.approvedAt?.toISOString() ?? "", a.note ?? "",
      ]);
      added++;
    } else {
      // Only Job Radar-owned columns are rewritten; Decision/To/Subject/Draft stay Wave's to edit.
      const cur = values[row - 1] ?? [];
      const want = { Status: a.status, "Draft ID": d?.id ?? "", Approved: d?.approvedAt?.toISOString() ?? "", Score: s?.score ?? "" };
      const changed = Object.entries(want).some(([k, v]) => String(cur[col(k)] ?? "") !== String(v));
      // A newer draft (e.g. a follow-up) replaces the text and needs a fresh Decision.
      const draftChanged = Boolean(d) && String(cur[col("Draft ID")] ?? "") !== String(d!.id);
      if (changed || draftChanged) {
        const r: (string | number | null)[] = [...cur, ...Array(HEADER.length).fill("")].slice(0, HEADER.length);
        r[col("Status")] = a.status; r[col("Draft ID")] = d?.id ?? ""; r[col("Approved")] = d?.approvedAt?.toISOString() ?? ""; r[col("Score")] = s?.score ?? "";
        if (draftChanged) {
          r[col("Draft")] = d!.body; r[col("Subject")] = d!.subject ?? ""; r[col("To")] = d!.toAddress ?? "";
          r[col("Account")] = accts.get(d!.accountId ?? -1) ?? ""; r[col("Decision")] = d!.approvedAt ? "Apply" : "";
        }
        await writeRange(acct, id, `${TAB}!A${row}:Q${row}`, [r]);
        updated++;
      }
    }
  }
  if (toAppend.length) await appendRows(acct, id, `${TAB}!A1`, toAppend);
  await logEvent("system", "sheet.synced", { added, updated });
  return { added, updated };
}

/** Pull: Wave's Decision column → approvals/skips; Wave's edits to To/Subject/Draft → the draft; new manual rows → add_job. */
export async function pollSheet() {
  const { id, acct } = await sheetCtx();
  const values = await readRange(acct, id, RANGE);
  const out = { approved: 0, skipped: 0, edited: 0, added: 0, errors: [] as string[] };
  const now = new Date();

  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const get = (k: string) => (r[col(k)] ?? "").toString().trim();
    const appId = Number(get("App ID"));
    try {
      if (!appId) {
        const link = get("Link");
        if (/^https?:\/\//.test(link)) {
          const job = await addJob(link, "wave");
          const jobId = job && "id" in job ? job.id : null;
          if (jobId) {
            const [app] = await db().insert(applications).values({ jobId, status: "shortlisted", note: get("Notes") || null }).onConflictDoNothing().returning();
            const appRowId = app?.id ?? (await db().select().from(applications).where(eq(applications.jobId, jobId)))[0]?.id;
            await writeRange(acct, id, `${TAB}!A${i + 1}`, [[appRowId]]);
            out.added++;
          }
        }
        continue;
      }
      const decision = get("Decision").toLowerCase();
      const [app] = await db().select().from(applications).where(eq(applications.id, appId));
      if (!app) continue;
      if (decision === "skip" && app.status === "shortlisted") {
        await updateStatus(appId, "skipped", "skipped in sheet", "wave"); out.skipped++; continue;
      }
      const draftId = Number(get("Draft ID"));
      if (!draftId) {
        if (decision === "apply" && app.status === "shortlisted") { await updateStatus(appId, "approved", "approved in sheet (no draft)", "wave"); out.approved++; }
        continue;
      }
      const [d] = await db().select().from(drafts).where(and(eq(drafts.id, draftId), eq(drafts.applicationId, appId)));
      if (!d || d.sentAt) continue;
      // Wave's edits in the sheet win. An edit after approval voids it (hash changes) until Apply is re-read below.
      const patch: Parameters<typeof editDraft>[1] = {};
      if (get("Draft") && get("Draft") !== d.body) patch.body = get("Draft");
      if (get("Subject") !== (d.subject ?? "")) patch.subject = get("Subject") || null;
      if (get("To").toLowerCase() !== (d.toAddress ?? "")) patch.to = get("To") || null;
      if (Object.keys(patch).length) { await editDraft(draftId, patch, "wave"); out.edited++; }
      const [fresh] = await db().select().from(drafts).where(eq(drafts.id, draftId));
      const approvalValid = fresh.approvedAt && fresh.approvedHash === fresh.contentHash;
      if (decision === "apply" && !approvalValid) { await approveDraft(draftId, "sheet", now); out.approved++; }
    } catch (e) {
      out.errors.push(`row ${i + 1}: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  if (out.approved || out.skipped || out.edited || out.added || out.errors.length) await logEvent("system", "sheet.polled", out);
  return out;
}
