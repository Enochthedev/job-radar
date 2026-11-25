import { getJson, htmlToText } from "../text.js";
import type { RawJob, SourceAdapter } from "./types.js";

interface HimalayasJob { guid: string; title: string; companyName: string; companySlug?: string; minSalary?: number | string; maxSalary?: number | string; salaryPeriod?: string; currency?: string; seniority?: string[]; locationRestrictions?: string[]; timezoneRestrictions?: number[]; categories?: string[]; description?: string; pubDate?: number | string; applicationLink?: string }

const PAGE = 20; // the API caps a page at 20
const PAGES = 25; // newest ~500; the API is ordered by date

export const himalayas: SourceAdapter = {
  name: "himalayas",
  everyHours: 6,
  async fetch() {
    const out: RawJob[] = [];
    for (let p = 0; p < PAGES; p++) {
      const data = await getJson<{ jobs: HimalayasJob[] }>(`https://himalayas.app/jobs/api?limit=${PAGE}&offset=${p * PAGE}`);
      for (const j of data.jobs ?? []) {
        const period = j.salaryPeriod === "hourly" ? "hour" : j.salaryPeriod === "monthly" ? "month" : j.minSalary ? "year" : null;
        out.push({
          source: "himalayas",
          externalId: j.guid,
          url: j.applicationLink ?? j.guid,
          company: j.companyName,
          title: j.title,
          locationRaw: !j.locationRestrictions?.length ? "Worldwide"
            : j.locationRestrictions.length > 8 ? `${j.locationRestrictions.length} countries${j.locationRestrictions.includes("Nigeria") ? " incl. Nigeria" : ""}`
            : j.locationRestrictions.join(", "),
          locationRestrictions: j.locationRestrictions ?? [],
          timezoneRestrictions: j.timezoneRestrictions ?? [],
          salaryMin: j.minSalary ? Math.round(Number(j.minSalary)) : null,
          salaryMax: j.maxSalary ? Math.round(Number(j.maxSalary)) : null,
          currency: j.currency ?? null,
          salaryPeriod: period,
          tags: [...(j.categories ?? []), ...(j.seniority ?? [])],
          description: htmlToText(j.description),
          postedAt: j.pubDate ? new Date(Number(j.pubDate) * 1000) : null,
        });
      }
      if ((data.jobs ?? []).length < PAGE) break;
    }
    return out;
  },
};
