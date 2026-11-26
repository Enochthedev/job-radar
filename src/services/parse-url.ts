import { config } from "../config.js";
import { llmExtractJob } from "../llm.js";
import { fetchAshby, fetchGreenhouse, fetchLever } from "../sources/ats.js";
import { parseHnComment } from "../sources/hn.js";
import { findSalary } from "../sources/salary.js";
import type { RawJob } from "../sources/types.js";
import { companyDomainFrom, decodeEntities, getJson, getText, htmlToText, UA } from "../text.js";

/** A page that can't become one job. The message is written for Claude to act on. */
export class NotAJobError extends Error {}

const JS_RENDERED = /(^|\.)notion\.(site|so)$|^forms\.gle$|^docs\.google\.com$|typeform\.com$|^tally\.so$|airtable\.com$|^jobs\.gem\.com$|^app\.dover\.com$/;

/** Known ATS URLs → their public APIs (cleanest data). */
async function fromAts(url: string): Promise<RawJob | null> {
  const u = new URL(url);
  const pick = (all: RawJob[], id: string) => all.find((j) => j.externalId.endsWith(`:${id}`));
  const gh = /greenhouse\.io$/.test(u.hostname) && url.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?#]+)\/jobs\/(\d+)/);
  if (gh) { const f = pick(await fetchGreenhouse({ name: gh[1], ats: "greenhouse", board: gh[1] }), gh[2]); if (f) return f; }
  const lv = u.hostname === "jobs.lever.co" && url.match(/lever\.co\/([^/]+)\/([0-9a-f-]{36})/);
  if (lv) { const f = pick(await fetchLever({ name: lv[1], ats: "lever", board: lv[1] }), lv[2]); if (f) return f; }
  const ab = u.hostname === "jobs.ashbyhq.com" && url.match(/ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/);
  if (ab) { const f = pick(await fetchAshby({ name: ab[1], ats: "ashby", board: ab[1] }), ab[2]); if (f) return f; }
  return null;
}

/** HN comment links → the Algolia item API (the HTML page is mostly chrome). */
async function fromHn(url: string): Promise<RawJob | null> {
  const id = new URL(url).hostname === "news.ycombinator.com" && new URL(url).searchParams.get("id");
  if (!id) return null;
  const item = await getJson<{ id: number; created_at_i?: number; text?: string; author?: string }>(`https://hn.algolia.com/api/v1/items/${id}`);
  const j = parseHnComment(item);
  if (!j) throw new NotAJobError("that HN item isn't a job post in the usual 'Company | Role | Location' format");
  return j;
}

interface GetroJob { title: string; url?: string; description?: string; postedAt?: string | number; organization?: { name?: string; domain?: string; websiteUrl?: string }; locations?: { name?: string }[] | string[]; workMode?: string; compensationAmountMinCents?: number; compensationAmountMaxCents?: number; compensationCurrency?: string; compensationPeriod?: string; status?: string }

/** Getro-powered boards (Techstars and many VC job boards) embed the job in __NEXT_DATA__. */
async function fromGetro(url: string, html: string, depth: number): Promise<RawJob | null> {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m || !/getro/i.test(html)) return null;
  const state = JSON.parse(m[1])?.props?.pageProps?.initialState;
  const cj = state?.jobs?.currentJob as GetroJob | undefined;
  if (!cj?.title) {
    const found = (state?.jobs?.found ?? []) as { title: string; slug: string; organization?: { slug?: string } }[];
    if (found.length) {
      const base = new URL(url).origin;
      const list = found.slice(0, 10).map((f) => `${f.title}: ${base}/companies/${f.organization?.slug}/jobs/${f.slug}`).join("\n");
      throw new NotAJobError(`this is a job board listing, not one job. Pass one role's URL, e.g.:\n${list}`);
    }
    return null;
  }
  if (cj.status && /closed|inactive|expired/i.test(cj.status)) throw new NotAJobError("this role is closed on the board");
  // Prefer the company's own ATS posting when the board links to one.
  if (cj.url && depth < 1 && /greenhouse\.io|lever\.co|ashbyhq\.com/.test(cj.url)) {
    const ats = await fromAts(cj.url).catch(() => null);
    if (ats) return { ...ats, url: cj.url };
  }
  const locs = (cj.locations ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
  const remote = cj.workMode && /remote/i.test(cj.workMode) ? "Remote" : null;
  const cents = (n?: number) => (n ? Math.round(n / 100) : null);
  return {
    source: "manual", externalId: url, url: cj.url && !/linkedin\.com/.test(cj.url) ? cj.url : url,
    title: cj.title, company: cj.organization?.name ?? new URL(url).hostname,
    companyDomain: companyDomainFrom(cj.organization?.websiteUrl ?? cj.organization?.domain ?? cj.url),
    locationRaw: [remote, locs.join(", ")].filter(Boolean).join(" · ") || null,
    salaryMin: cents(cj.compensationAmountMinCents), salaryMax: cents(cj.compensationAmountMaxCents),
    currency: cj.compensationCurrency ?? null,
    salaryPeriod: cj.compensationPeriod === "hour" ? "hour" : cj.compensationPeriod === "month" ? "month" : cj.compensationAmountMinCents ? "year" : null,
    description: htmlToText(cj.description), postedAt: cj.postedAt ? new Date(cj.postedAt) : null,
  };
}

/** schema.org JobPosting JSON-LD (most careers pages, YC job pages). */
export function fromJsonLd(url: string, html: string): RawJob | null {
  const u = new URL(url);
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      const list = Array.isArray(data) ? data : data["@graph"] ?? [data];
      const jp = list.find((x: { "@type"?: string | string[] }) => [x["@type"]].flat().includes("JobPosting"));
      if (!jp?.title) continue;
      const loc = [jp.applicantLocationRequirements, jp.jobLocation].flat().filter(Boolean)
        .map((l: { name?: string; address?: { addressCountry?: string | { name?: string }; addressLocality?: string } }) =>
          l.name ?? [l.address?.addressLocality, typeof l.address?.addressCountry === "string" ? l.address.addressCountry : l.address?.addressCountry?.name].filter(Boolean).join(", "))
        .filter(Boolean).join("; ");
      const sal = jp.baseSalary?.value;
      const unit = String(sal?.unitText ?? jp.baseSalary?.unitText ?? "");
      const description = htmlToText(jp.description);
      const fromText = findSalary(description);
      return {
        source: "manual", externalId: url, url, title: decodeEntities(jp.title),
        company: decodeEntities(jp.hiringOrganization?.name ?? u.hostname),
        companyDomain: companyDomainFrom(jp.hiringOrganization?.sameAs ?? jp.hiringOrganization?.url) ?? companyDomainFrom(url),
        locationRaw: [jp.jobLocationType === "TELECOMMUTE" ? "Remote" : null, loc].filter(Boolean).join(" · ") || null,
        ...(sal ? {
          salaryMin: sal.minValue ?? sal.value ?? null, salaryMax: sal.maxValue ?? null, currency: jp.baseSalary?.currency ?? null,
          salaryPeriod: /HOUR/i.test(unit) ? "hour" : /MONTH/i.test(unit) ? "month" : "year",
        } : fromText),
        description, postedAt: jp.datePosted ? new Date(jp.datePosted) : null,
      };
    } catch { /* not JSON we understand */ }
  }
  return null;
}

/** Renders JS-only pages (Notion, Google Forms…) to readable text via Jina Reader. */
async function rendered(url: string): Promise<string> {
  const key = config().JINA_API_KEY;
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { "user-agent": UA, accept: "text/plain", "x-timeout": "25", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`could not render ${url} (${res.status})`);
  return (await res.text()).replace(/^[\s\S]*?Markdown Content:\s*/, "");
}

const CURRENCY: Record<string, string> = { "$": "USD", US$: "USD", "€": "EUR", "£": "GBP", "₦": "NGN", C$: "CAD", A$: "AUD" };
const currencyCode = (c: string | null) => (c ? CURRENCY[c.trim()] ?? c.trim().toUpperCase().slice(0, 3) : null);

async function fromText(url: string, text: string, depth: number): Promise<RawJob> {
  const u = new URL(url);
  const x = await llmExtractJob(url, text);
  if (!x) {
    // No LLM configured: keep the old best-effort parse rather than fail.
    const title = text.split("\n").find((l) => l.trim().length > 3)?.trim().slice(0, 200) ?? url;
    return { source: "manual", externalId: url, url, title, company: u.hostname.replace(/^www\.|^jobs\.|^careers\./, ""), companyDomain: companyDomainFrom(url), description: text.slice(0, 20000), ...findSalary(text) };
  }
  if (x.is_closed) throw new NotAJobError("the page says applications for this role are closed");
  if (!x.is_job_posting) {
    if (x.details_url && depth < 1) {
      const next = new URL(x.details_url, url).toString();
      if (next !== url) return parseJobUrl(next, depth + 1);
    }
    if (x.listed_roles.length) {
      const list = x.listed_roles.map((r) => `${r.title}${r.url ? `: ${new URL(r.url, url)}` : ""}`).join("\n");
      throw new NotAJobError(`${url} lists several roles, not one. Pass one role's URL (open the page to get the links):\n${list}`);
    }
    throw new NotAJobError(x.is_application_form
      ? "this is an application form with no role description; find the job description page and add that instead"
      : "couldn't find a job description on this page");
  }
  const sal = x.salary_min || x.salary_max ? { salaryMin: x.salary_min, salaryMax: x.salary_max, currency: currencyCode(x.salary_currency), salaryPeriod: x.salary_period ?? "year" } : findSalary(text);
  return {
    source: "manual", externalId: url, url, title: x.title ?? u.hostname,
    company: x.company ?? u.hostname.replace(/^www\.|^jobs\.|^careers\./, ""),
    companyDomain: companyDomainFrom(x.company_website) ?? companyDomainFrom(url),
    locationRaw: x.location, ...sal, description: text.slice(0, 20000),
    postedAt: x.posted_date && !Number.isNaN(Date.parse(x.posted_date)) ? new Date(x.posted_date) : null,
  };
}

/**
 * Turns a job URL into a RawJob. Order: ATS APIs → HN → Getro boards → JSON-LD →
 * page text (rendered via Jina for JS-only hosts) read by the LLM. Throws NotAJobError
 * with an actionable message for boards, forms, closed roles and non-job pages.
 */
export async function parseJobUrl(url: string, depth = 0): Promise<RawJob> {
  const u = new URL(url);
  const ats = await fromAts(url); if (ats) return { ...ats, onWatchlist: false };
  const hn = await fromHn(url); if (hn) return hn;

  if (JS_RENDERED.test(u.hostname)) return fromText(url, await rendered(url), depth);

  const html = await getText(url);
  const getro = await fromGetro(url, html, depth); if (getro) return getro;
  const ld = fromJsonLd(url, html); if (ld) return ld;
  let text = htmlToText(html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html);
  if (text.length < 500) text = await rendered(url).catch(() => text); // JS app shell
  return fromText(url, text, depth);
}
