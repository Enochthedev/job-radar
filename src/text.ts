import { createHash } from "node:crypto";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/" };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => ENTITIES[n] ?? m);
}

/** HTML → readable plain text. Job descriptions and emails are untrusted; we never keep their HTML. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = decodeEntities(html); // some feeds double-escape
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<p[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

export function jobHash(company: string, title: string): string {
  const norm = (x: string) => x.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(`${norm(company)}|${norm(title)}`).digest("hex").slice(0, 32);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

const BOARD_DOMAINS = ["remoteok.com", "remotive.com", "himalayas.app", "weworkremotely.com", "news.ycombinator.com",
  "greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "linkedin.com", "wellfound.com", "notion.site", "google.com", "forms.gle", "docs.google.com", "typeform.com"];

/** A company domain is only useful if it isn't the board's own. */
export function companyDomainFrom(url: string | null | undefined): string | null {
  const d = domainOf(url);
  if (!d) return null;
  return BOARD_DOMAINS.some((b) => d === b || d.endsWith(`.${b}`)) ? null : d;
}

export const UA = "job-radar/0.1 (+https://github.com/Enochthedev/job-radar)";

export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return (await res.json()) as T;
}

export async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}
