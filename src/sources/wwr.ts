import { decodeEntities, getText, htmlToText } from "../text.js";
import type { RawJob, SourceAdapter } from "./types.js";

const FEEDS = [
  "remote-programming-jobs",
  "remote-back-end-programming-jobs",
  "remote-full-stack-programming-jobs",
  "remote-devops-sysadmin-jobs",
];

function tag(item: string, name: string): string | null {
  const m = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return null;
  return decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim();
}

export function parseWwrRss(xml: string): RawJob[] {
  const items = xml.split(/<item>/i).slice(1).map((s) => s.split(/<\/item>/i)[0]);
  return items.map((item): RawJob => {
    const rawTitle = tag(item, "title") ?? "";
    const idx = rawTitle.indexOf(": ");
    const company = idx > 0 ? rawTitle.slice(0, idx) : "Unknown";
    const title = idx > 0 ? rawTitle.slice(idx + 2) : rawTitle;
    const link = tag(item, "link") ?? tag(item, "guid") ?? "";
    const desc = htmlToText(tag(item, "description"));
    const urlLine = desc.match(/URL:\s*(\S+)/);
    return {
      source: "wwr",
      externalId: tag(item, "guid") ?? link,
      url: link,
      company,
      companyDomain: urlLine ? urlLine[1].replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] : null,
      title,
      locationRaw: tag(item, "region"),
      tags: [tag(item, "category") ?? ""].filter(Boolean),
      description: desc,
      postedAt: tag(item, "pubDate") ? new Date(tag(item, "pubDate")!) : null,
    };
  });
}

export const wwr: SourceAdapter = {
  name: "wwr",
  everyHours: 6,
  async fetch() {
    const all: RawJob[] = [];
    for (const f of FEEDS) {
      try {
        all.push(...parseWwrRss(await getText(`https://weworkremotely.com/categories/${f}.rss`)));
      } catch (e) {
        console.warn(`[wwr] ${f}: ${(e as Error).message}`);
      }
    }
    return all;
  },
};
