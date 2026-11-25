import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context, type Next } from "hono";
import { basicAuth } from "hono/basic-auth";
import { secureHeaders } from "hono/secure-headers";
import { desc, eq, inArray, isNull, sql as dsql } from "drizzle-orm";
import { config, googleConfigured } from "../config.js";
import { db, sql } from "../db/client.js";
import { accounts, applications, drafts, events, jobs, scores } from "../db/schema.js";
import { safeEqual, signState, verifyState } from "../google/crypto.js";
import { authUrl, completeOAuth } from "../google/oauth.js";
import { buildMcpServer } from "../mcp/server.js";
import { approveDraft, editDraft, sendEmail } from "../services/drafts.js";
import { inboxDigest } from "../services/inbox.js";
import { refreshSources } from "../services/ingest.js";
import { draftView, getJob, searchJobs, stats, updateStatus, type AppStatus } from "../services/jobs.js";
import { pollSheet, syncSheet } from "../services/sheet.js";
import { dashboardHtml } from "./dashboard.js";

const c = config();
const app = new Hono();
app.use("*", secureHeaders());

app.get("/health", async (ctx) => {
  try { await sql()`select 1`; return ctx.json({ ok: true, sending_enabled: c.SENDING_ENABLED, google: googleConfigured() }); }
  catch { return ctx.json({ ok: false }, 503); }
});

// ── MCP (Claude) ─────────────────────────────────────────────────────────────
// Bearer header for clients that support it; /mcp/<token> for claude.ai custom connectors,
// which only take a URL. Stateless: a fresh server + transport per request.
async function handleMcp(ctx: Context) {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildMcpServer();
  await server.connect(transport);
  try {
    return await transport.handleRequest(ctx.req.raw);
  } finally {
    // Close after the response is produced (JSON mode returns a complete body).
    setTimeout(() => { transport.close().catch(() => {}); server.close().catch(() => {}); }, 0);
  }
}
const bearer = (expected: string) => async (ctx: Context, next: Next) => {
  const h = ctx.req.header("authorization") ?? "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok || !safeEqual(tok, expected)) return ctx.json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  await next();
};
app.all("/mcp", bearer(c.MCP_BEARER_TOKEN), handleMcp);
app.all("/mcp/:token", async (ctx) => {
  if (!safeEqual(ctx.req.param("token"), c.MCP_BEARER_TOKEN)) return ctx.json({ error: "unauthorized" }, 401);
  return handleMcp(ctx);
});

// ── Dashboard API (Wave, via the HQ app server-side) ─────────────────────────
// DASHBOARD_TOKEN is separate from the MCP token: it is the only credential that can approve.
const api = new Hono();
api.use("*", bearer(c.DASHBOARD_TOKEN));

api.get("/overview", async (ctx) => {
  const [s, accts, pending] = await Promise.all([
    stats("30d"),
    db().select().from(accounts).orderBy(desc(accounts.connectedAt)),
    db().select({ n: dsql<number>`count(*)::int` }).from(drafts).where(isNull(drafts.sentAt)),
  ]);
  return ctx.json({
    stats: s, sending_enabled: c.SENDING_ENABLED, google_configured: googleConfigured(), sheet_configured: Boolean(c.JOB_TRACKER_SHEET_ID),
    accounts: accts.map((a) => ({ id: a.id, email: a.email, label: a.label, status: a.status, last_sync_at: a.lastSyncAt, scopes: a.scopes })),
    unsent_drafts: pending[0]?.n ?? 0,
  });
});

api.get("/applications", async (ctx) => {
  const status = ctx.req.query("status")?.split(",").filter(Boolean) as AppStatus[] | undefined;
  const rows = await db().select({ a: applications, j: jobs, s: scores }).from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId)).leftJoin(scores, eq(scores.jobId, jobs.id))
    .where(status?.length ? inArray(applications.status, status) : undefined)
    .orderBy(desc(applications.updatedAt)).limit(Number(ctx.req.query("limit") ?? 200));
  const ids = rows.map((r) => r.a.id);
  const ds = ids.length ? await db().select().from(drafts).where(inArray(drafts.applicationId, ids)).orderBy(desc(drafts.id)) : [];
  return ctx.json(rows.map((r) => ({
    id: r.a.id, status: r.a.status, channel: r.a.channel, applied_at: r.a.appliedAt, next_follow_up_at: r.a.nextFollowUpAt,
    follow_up_count: r.a.followUpCount, note: r.a.note, updated_at: r.a.updatedAt,
    job: { id: r.j.id, company: r.j.company, title: r.j.title, url: r.j.url, location: r.j.locationRaw, eligibility: r.j.eligibility, eligibility_reason: r.j.eligibilityReason, source: r.j.source, posted_at: r.j.postedAt, score: r.s?.score ?? null, reasons: r.s?.reasons ?? null },
    drafts: ds.filter((d) => d.applicationId === r.a.id).map(draftView),
  })));
});

api.get("/jobs", async (ctx) => ctx.json(await searchJobs({
  query: ctx.req.query("q"), min_score: ctx.req.query("min_score") ? Number(ctx.req.query("min_score")) : undefined,
  eligibility: ctx.req.query("eligibility") as "eligible" | undefined, limit: Number(ctx.req.query("limit") ?? 50),
})));
api.get("/jobs/:id", async (ctx) => { const j = await getJob(Number(ctx.req.param("id"))); return j ? ctx.json(j) : ctx.json({ error: "not found" }, 404); });

api.patch("/drafts/:id", async (ctx) => {
  const b = await ctx.req.json<{ subject?: string | null; body?: string; to?: string | null; account?: string }>();
  return ctx.json(draftView(await editDraft(Number(ctx.req.param("id")), b, "wave")));
});
api.post("/drafts/:id/approve", async (ctx) => ctx.json(await approveDraft(Number(ctx.req.param("id")), "dashboard")));
api.post("/drafts/:id/send", async (ctx) => ctx.json(await sendEmail(Number(ctx.req.param("id")), "wave")));
api.post("/applications/:id/status", async (ctx) => {
  const b = await ctx.req.json<{ status: AppStatus; note?: string }>();
  return ctx.json(await updateStatus(Number(ctx.req.param("id")), b.status, b.note, "wave"));
});
api.post("/refresh", async (ctx) => ctx.json(await refreshSources(ctx.req.query("source") || undefined)));
api.post("/sheet/sync", async (ctx) => ctx.json({ push: await syncSheet(), pull: await pollSheet() }));
api.get("/inbox", async (ctx) => ctx.json(await inboxDigest({ since: ctx.req.query("since"), account: ctx.req.query("account") })));
api.get("/events", async (ctx) => ctx.json(await db().select().from(events).orderBy(desc(events.id)).limit(Math.min(Number(ctx.req.query("limit") ?? 100), 500))));
// HQ renders a Connect button; this returns the Google URL with a signed state.
api.get("/oauth/url", (ctx) => {
  if (!googleConfigured()) return ctx.json({ error: "Google OAuth is not configured" }, 400);
  const primary = ctx.req.query("primary") === "1";
  const state = signState({ label: ctx.req.query("label") ?? null, primary, return_to: ctx.req.query("return_to") ?? null });
  return ctx.json({ url: authUrl(state, primary, ctx.req.query("hint")) });
});
api.onError((err, ctx) => ctx.json({ error: err.message }, /not found/.test(err.message) ? 404 : 400));
app.route("/api", api);

// ── Browser routes: dashboard + OAuth ────────────────────────────────────────
// Cloudflare Access sits in front; basic auth is a second lock if it's ever misconfigured.
const pageAuth = c.DASHBOARD_PASSWORD
  ? basicAuth({ username: "wave", password: c.DASHBOARD_PASSWORD })
  : async (ctx: Context) => ctx.text("Set DASHBOARD_PASSWORD to enable the dashboard", 503);

app.get("/dashboard", pageAuth, async (ctx) => {
  const accts = await db().select().from(accounts).orderBy(desc(accounts.connectedAt));
  return ctx.html(dashboardHtml({ accounts: accts, sendingEnabled: c.SENDING_ENABLED, googleConfigured: googleConfigured(), sheetConfigured: Boolean(c.JOB_TRACKER_SHEET_ID) }));
});

app.get("/oauth/google/start", pageAuth, (ctx) => {
  if (!googleConfigured()) return ctx.text("Google OAuth is not configured", 400);
  const primary = ctx.req.query("primary") === "1";
  const state = signState({ label: ctx.req.query("label") ?? null, primary, return_to: null });
  return ctx.redirect(authUrl(state, primary, ctx.req.query("hint")));
});

const RETURN_HOSTS = ["app.wavedidwhat.com", "hq.dev.wavedidwhat.com", "localhost"];
app.get("/oauth/google/callback", async (ctx) => {
  const err = ctx.req.query("error");
  if (err) return ctx.text(`Google said: ${err}`, 400);
  try {
    const st = verifyState<{ label: string | null; return_to: string | null }>(ctx.req.query("state") ?? "");
    const acct = await completeOAuth(ctx.req.query("code") ?? "", st.label ?? undefined);
    if (st.return_to) {
      const u = new URL(st.return_to);
      if (RETURN_HOSTS.includes(u.hostname)) { u.searchParams.set("connected", acct.email); return ctx.redirect(u.toString()); }
    }
    return ctx.redirect(`/dashboard?connected=${encodeURIComponent(acct.email)}`);
  } catch (e) {
    return ctx.text(`Could not connect: ${(e as Error).message}`, 400);
  }
});

app.get("/", (ctx) => ctx.text("job-radar"));
app.notFound((ctx) => ctx.json({ error: "not found" }, 404));

serve({ fetch: app.fetch, port: c.PORT, hostname: "0.0.0.0" }, (i) => console.log(`radar-api listening on :${i.port}`));
