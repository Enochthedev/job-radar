import { getJson, htmlToText } from "../text.js";
import type { RawJob, SourceAdapter } from "./types.js";

interface RemoteOkJob { id?: string; slug?: string; date?: string; company?: string; position?: string; tags?: string[]; description?: string; location?: string; apply_url?: string; url?: string; salary_min?: number; salary_max?: number }

// RemoteOK's terms require crediting them with a link; every job keeps its remoteok.com url.
export const remoteok: SourceAdapter = {
  name: "remoteok",
  everyHours: 3,
  async fetch() {
    const data = await getJson<RemoteOkJob[]>("https://remoteok.com/api");
    return data
      .filter((j) => j.id && j.position)
      .map((j): RawJob => ({
        source: "remoteok",
        externalId: String(j.id),
        url: j.url ?? `https://remoteok.com/remote-jobs/${j.slug}`,
        company: j.company ?? "Unknown",
        title: j.position!,
        locationRaw: j.location || null,
        salaryMin: j.salary_min || null,
        salaryMax: j.salary_max || null,
        currency: j.salary_min ? "USD" : null,
        salaryPeriod: j.salary_min ? "year" : null,
        tags: j.tags ?? [],
        description: htmlToText(j.description),
        postedAt: j.date ? new Date(j.date) : null,
      }));
  },
};
