import { classify } from "../filter/classify.js";
import { loadProfile, type Profile } from "../profile.js";
import { decodeEntities, getJson, getText, companyDomainFrom } from "../text.js";
import { parseSalaryText } from "./salary.js";
import type { RawJob, SourceAdapter } from "./types.js";

/**
 * YC companies, read from their public YC company pages (ycombinator.com/companies/<slug>/jobs),
 * not Work at a Startup (which needs a login). The company list comes from yc-oss, a public
 * daily mirror of YC's directory; profile.yaml `yc_directory` decides which companies to watch.
 */

interface YcCompany { slug: string; name: string; website?: string; regions?: string[]; all_locations?: string; industry?: string; tags?: string[]; team_size?: number; status?: string; isHiring?: boolean; batch?: string }
interface YcPosting { id: number; title: string; url: string; location?: string; salaryRange?: string; type?: string; minExperience?: string; visa?: string; skills?: { name?: string }[] | string[]; roleSpecificType?: string; createdAt?: string; companyName?: string }

const DIRECTORY = "https://yc-oss.github.io/api/companies/hiring.json";

/** YC's visa field, restated so the eligibility gate reads it the right way round. */
export function visaLine(v: string | undefined): string {
  if (!v) return "";
  if (/not required/i.test(v)) return "Work authorisation: none required for this role.";
  if (/sponsor/i.test(v)) return "Work authorisation: visa sponsorship available.";
  if (/only/i.test(v)) return "Work authorisation: US citizen only (or existing US work visa).";
  return `Work authorisation: ${v}`;
}

export function selectCompanies(all: YcCompany[], cfg: Profile["yc_directory"]): YcCompany[] {
  const wantRegion = (c: YcCompany) => (c.regions ?? []).some((r) => cfg.regions.includes(r)) || cfg.regions.some((r) => (c.all_locations ?? "").includes(r));
  const wantTopic = (c: YcCompany) => !cfg.industries.length && !cfg.tags.length
    || cfg.industries.includes(c.industry ?? "") || (c.tags ?? []).some((t) => cfg.tags.includes(t));
  const rank = (c: YcCompany) => ((c.regions ?? []).includes("Fully Remote") ? 2 : 0) + (/africa|nigeria/i.test(`${c.regions} ${c.all_locations}`) ? 1 : 0);
  return all
    .filter((c) => c.status === "Active" && c.isHiring !== false && (c.team_size ?? 0) >= cfg.min_team_size && wantRegion(c) && wantTopic(c))
    .sort((a, b) => rank(b) - rank(a) || (b.team_size ?? 0) - (a.team_size ?? 0))
    .slice(0, cfg.max_companies);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GAP_MS = 1500; // ycombinator.com rate-limits bursts; one request at a time, spaced out.

class RateLimited extends Error {}

/** GET with one polite retry on 429; a second 429 ends the run (we keep what we have). */
async function politeGet(url: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await getText(url);
    } catch (e) {
      if (!/→ 429/.test((e as Error).message)) throw e;
      if (attempt === 0) { await sleep(30_000); continue; }
      throw new RateLimited("ycombinator.com rate-limited us; stopping this run early");
    }
  }
  throw new RateLimited("unreachable");
}

async function postingsFor(slug: string): Promise<YcPosting[]> {
  const html = await politeGet(`https://www.ycombinator.com/companies/${encodeURIComponent(slug)}/jobs`);
  const m = html.match(/data-page="([^"]+)"/);
  if (!m) return [];
  return (JSON.parse(decodeEntities(m[1]))?.props?.jobPostings ?? []) as YcPosting[];
}

/** Full description from the job page's JSON-LD, only for roles that already pass the cheap gates. */
async function enrich(job: RawJob): Promise<RawJob> {
  try {
    const { fromJsonLd } = await import("../services/parse-url.js");
    const ld = fromJsonLd(job.url, await politeGet(job.url));
    if (ld?.description) return { ...job, description: `${job.description ?? ""}\n\n${ld.description}`.trim(), postedAt: ld.postedAt ?? job.postedAt };
  } catch { /* keep the listing data */ }
  return job;
}

/** Sequential, spaced requests. Stops early (keeping results) if YC rate-limits us twice. */
async function paced<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const t of items) {
    try { out.push(await fn(t)); } catch (e) {
      if (e instanceof RateLimited) { console.warn(`[yc] ${e.message} after ${out.length}/${items.length}`); break; }
      console.warn(`[yc] ${(e as Error).message}`);
    }
    await sleep(GAP_MS);
  }
  return out;
}

export function ycAdapter(): SourceAdapter {
  return {
    name: "yc",
    everyHours: 24,
    async fetch() {
      const profile = loadProfile();
      const cfg = profile.yc_directory;
      if (!cfg.enabled) return [];
      const companies = selectCompanies(await getJson<YcCompany[]>(DIRECTORY), cfg);
      const perCompany = await paced(companies, async (c) => {
        const posts = await postingsFor(c.slug);
        return posts.filter((p) => !p.type || /full|contract/i.test(p.type)).map((p): RawJob => {
          const skills = (p.skills ?? []).map((s) => (typeof s === "string" ? s : s.name)).filter((x): x is string => Boolean(x));
          return {
            source: "yc",
            externalId: String(p.id),
            url: p.url.startsWith("http") ? p.url : `https://www.ycombinator.com${p.url}`,
            company: c.name,
            companyDomain: companyDomainFrom(c.website),
            title: p.title,
            locationRaw: p.location ?? null,
            ...parseSalaryText(p.salaryRange),
            tags: [...skills, ...(c.tags ?? [])],
            // Visa + experience lines feed the eligibility and level gates.
            description: [visaLine(p.visa), p.minExperience ? `Experience: ${p.minExperience}` : "", skills.length ? `Skills: ${skills.join(", ")}` : ""].filter(Boolean).join("\n"),
            postedAt: p.createdAt ? new Date(p.createdAt) : null,
            isYc: true,
          };
        });
      });
      const jobs = perCompany.flat();
      // Fetch full text only for roles that survive the title/location/level gates.
      const keep = jobs.filter((j) => !classify(j, profile).rejectReason);
      const enriched = new Map((await paced(keep, enrich)).map((j) => [j.externalId, j]));
      return jobs.map((j) => enriched.get(j.externalId) ?? j);
    },
  };
}
