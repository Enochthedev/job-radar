import { getJson, htmlToText } from "../text.js";
import { parseSalaryText } from "./salary.js";
import type { RawJob, SourceAdapter } from "./types.js";

interface RemotiveJob { id: number; url: string; title: string; company_name: string; tags?: string[]; publication_date?: string; candidate_required_location?: string; salary?: string; description?: string }

export const remotive: SourceAdapter = {
  name: "remotive",
  everyHours: 3,
  async fetch() {
    const out: RawJob[] = [];
    for (const category of ["software-dev", "devops", "customer-support"]) {
      const data = await getJson<{ jobs: RemotiveJob[] }>(`https://remotive.com/api/remote-jobs?category=${category}`);
      for (const j of data.jobs) {
        const sal = parseSalaryText(j.salary);
        out.push({
          source: "remotive",
          externalId: String(j.id),
          url: j.url,
          company: j.company_name,
          title: j.title,
          locationRaw: j.candidate_required_location || null,
          ...sal,
          tags: j.tags ?? [],
          description: htmlToText(j.description),
          postedAt: j.publication_date ? new Date(`${j.publication_date}Z`) : null,
        });
      }
    }
    return out;
  },
};
