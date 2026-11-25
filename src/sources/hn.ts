import { getJson, htmlToText, companyDomainFrom } from "../text.js";
import type { RawJob, SourceAdapter } from "./types.js";

interface HnItem { id: number; created_at_i?: number; text?: string | null; author?: string; children?: HnItem[] }

const ROLE_WORDS = /engineer|developer|programmer|swe\b|full[- ]?stack|back[- ]?end|front[- ]?end|devops|sre\b|platform|founding/i;

/**
 * HN "Who is hiring" comments follow a loose convention:
 *   Company | Role(s) | Location | REMOTE/ONSITE | VISA | salary | url
 * We parse that header line; everything else becomes the description. Eligibility is decided
 * later (regex, then the LLM pass for anything unclear).
 */
export function parseHnComment(c: HnItem): RawJob | null {
  if (!c.text || !c.author) return null;
  const text = htmlToText(c.text);
  const header = text.split("\n")[0];
  const parts = header.split(/\s+\|\s+|\s+\|\s*|\s*\|\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const company = parts[0].replace(/\s*\(.*?\)\s*/g, " ").trim().slice(0, 120);
  const role = parts.slice(1).find((p) => ROLE_WORDS.test(p)) ?? null;
  if (!role) return null;
  // Header segments are short; a long one means the description ran into the header line.
  const location = parts.filter((p) => p !== role && p !== parts[0] && p.length <= 80).join(" | ").slice(0, 200) || null;
  const firstUrl = c.text.match(/href="([^"]+)"/)?.[1]?.replace(/&#x2F;/g, "/") ?? null;

  return {
    source: "hn",
    externalId: String(c.id),
    url: `https://news.ycombinator.com/item?id=${c.id}`,
    company,
    companyDomain: companyDomainFrom(firstUrl),
    title: role.slice(0, 200),
    locationRaw: location,
    description: text,
    postedAt: c.created_at_i ? new Date(c.created_at_i * 1000) : null,
    isYc: /\(YC [WSF]\d{2}\)|\bYC [WSF]\d{2}\b/i.test(header),
  };
}

export const hn: SourceAdapter = {
  name: "hn",
  everyHours: 6,
  async fetch() {
    const search = await getJson<{ hits: { objectID: string; title: string }[] }>(
      "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5",
    );
    const story = search.hits.find((h) => /who is hiring/i.test(h.title));
    if (!story) return [];
    const item = await getJson<HnItem>(`https://hn.algolia.com/api/v1/items/${story.objectID}`);
    return (item.children ?? []).map(parseHnComment).filter((j): j is RawJob => j !== null);
  },
};
