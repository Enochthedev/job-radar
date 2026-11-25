import { getJson, htmlToText, decodeEntities } from "../text.js";
import type { Profile } from "../profile.js";
import type { RawJob, SourceAdapter } from "./types.js";

type Company = Profile["watchlist"][number];

interface GhJob { id: number; title: string; absolute_url: string; location?: { name?: string }; updated_at?: string; first_published?: string; content?: string }
interface LeverJob { id: string; text: string; hostedUrl: string; categories?: { location?: string; allLocations?: string[] }; workplaceType?: string; createdAt?: number; descriptionPlain?: string; additionalPlain?: string; salaryRange?: { min?: number; max?: number; currency?: string; interval?: string } }
interface AshbyJob { id: string; title: string; location?: string; secondaryLocations?: { location?: string }[]; isRemote?: boolean; workplaceType?: string; publishedAt?: string; jobUrl: string; descriptionPlain?: string; compensation?: { summaryComponents?: { compensationType?: string; minValue?: number; maxValue?: number; currencyCode?: string; interval?: string }[] } }

export async function fetchGreenhouse(c: Company): Promise<RawJob[]> {
  const data = await getJson<{ jobs: GhJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${c.board}/jobs?content=true`);
  return data.jobs.map((j) => ({
    source: "greenhouse",
    externalId: `${c.board}:${j.id}`,
    url: j.absolute_url,
    company: c.name,
    title: j.title,
    locationRaw: j.location?.name ?? null,
    description: htmlToText(decodeEntities(j.content ?? "")),
    postedAt: j.first_published ? new Date(j.first_published) : j.updated_at ? new Date(j.updated_at) : null,
    isYc: Boolean(c.yc),
    onWatchlist: true,
  }));
}

export async function fetchLever(c: Company): Promise<RawJob[]> {
  const data = await getJson<LeverJob[]>(`https://api.lever.co/v0/postings/${c.board}?mode=json`);
  return data.map((j) => ({
    source: "lever",
    externalId: `${c.board}:${j.id}`,
    url: j.hostedUrl,
    company: c.name,
    title: j.text,
    locationRaw: [j.categories?.allLocations?.join(", ") ?? j.categories?.location, j.workplaceType].filter(Boolean).join(" · ") || null,
    salaryMin: j.salaryRange?.min ?? null,
    salaryMax: j.salaryRange?.max ?? null,
    currency: j.salaryRange?.currency ?? null,
    salaryPeriod: j.salaryRange ? (/hour/i.test(j.salaryRange.interval ?? "") ? "hour" : /month/i.test(j.salaryRange.interval ?? "") ? "month" : "year") : null,
    description: [j.descriptionPlain, j.additionalPlain].filter(Boolean).join("\n\n"),
    postedAt: j.createdAt ? new Date(j.createdAt) : null,
    isYc: Boolean(c.yc),
    onWatchlist: true,
  }));
}

export async function fetchAshby(c: Company): Promise<RawJob[]> {
  const data = await getJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.board)}?includeCompensation=true`);
  return data.jobs.map((j) => {
    const sal = j.compensation?.summaryComponents?.find((s) => s.compensationType === "Salary");
    const locs = [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean);
    return {
      source: "ashby",
      externalId: `${c.board}:${j.id}`,
      url: j.jobUrl,
      company: c.name,
      title: j.title,
      locationRaw: [locs.join(", "), j.isRemote ? "Remote" : j.workplaceType].filter(Boolean).join(" · ") || null,
      salaryMin: sal?.minValue ?? null,
      salaryMax: sal?.maxValue ?? null,
      currency: sal?.currencyCode ?? null,
      salaryPeriod: sal ? (/hour/i.test(sal.interval ?? "") ? "hour" : /month/i.test(sal.interval ?? "") ? "month" : "year") : null,
      description: j.descriptionPlain ?? "",
      postedAt: j.publishedAt ? new Date(j.publishedAt) : null,
      isYc: Boolean(c.yc),
      onWatchlist: true,
    } satisfies RawJob;
  });
}

export function careersAdapter(watchlist: Company[]): SourceAdapter {
  return {
    name: "careers",
    everyHours: 12,
    async fetch() {
      const out: RawJob[] = [];
      for (const c of watchlist) {
        try {
          const fn = c.ats === "greenhouse" ? fetchGreenhouse : c.ats === "lever" ? fetchLever : fetchAshby;
          out.push(...(await fn(c)));
        } catch (e) {
          console.warn(`[careers] ${c.name} (${c.ats}/${c.board}): ${(e as Error).message}`);
        }
      }
      return out;
    },
  };
}
