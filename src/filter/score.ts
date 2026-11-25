import type { Profile } from "../profile.js";
import { yearlyUsd } from "../sources/salary.js";

export interface Scorable {
  title: string;
  description?: string | null;
  stack: string[];
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string | null;
  salaryPeriod?: string | null;
  postedAt?: Date | null;
  remoteScope?: string | null;
  isYc?: boolean;
  onWatchlist?: boolean;
  tags?: string[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRx = (t: string) => new RegExp(`(^|[^a-z0-9])${esc(t.trim())}([^a-z0-9]|$)`, "i");

export function scoreJob(j: Scorable, p: Profile, now = new Date()): { score: number; reasons: Record<string, number | string> } {
  const s = p.score;
  const reasons: Record<string, number | string> = {};
  const text = `${j.title}\n${(j.tags ?? []).join(" ")}\n${j.description ?? ""}`;

  // Stack: share of the target stack the job mentions.
  const target = new Set(["typescript", "node", "go", "postgres", "redis"]);
  const hit = j.stack.filter((x) => target.has(x));
  const stackPts = Math.round((Math.min(hit.length, 4) / 4) * s.stack.weight);
  if (stackPts) reasons.stack = stackPts;

  // Domain overlap with the candidate's proof (profile.yaml score.domain).
  const domains = [...new Set(s.domain.terms.filter((t) => termRx(t).test(text)).map((t) => t.toLowerCase()))];
  const domainPts = Math.min(s.domain.weight, domains.length * 7);
  if (domainPts) { reasons.domain = domainPts; reasons.domain_terms = domains.slice(0, 4).join(", "); }

  // Pay listed and at/above floor.
  const yearly = yearlyUsd(j.salaryMax ?? j.salaryMin, j.currency, j.salaryPeriod ?? "year");
  if (yearly && yearly >= s.pay.floor_usd_year) { reasons.pay = s.pay.weight; reasons.pay_usd_year = yearly; }

  // Stage.
  if (j.isYc || s.stage.terms.some((t) => text.toLowerCase().includes(t.toLowerCase()))) reasons.stage = s.stage.weight;

  // Freshness.
  if (j.postedAt && now.getTime() - j.postedAt.getTime() <= s.fresh.hours * 3600_000) reasons.fresh = s.fresh.weight;

  if (j.remoteScope === "worldwide") reasons.remote_worldwide = s.remote_worldwide.weight;
  if (j.onWatchlist) reasons.watchlist = s.watchlist.weight;

  const POINT_KEYS = ["stack", "domain", "pay", "stage", "fresh", "remote_worldwide", "watchlist"];
  const score = POINT_KEYS.reduce((sum, k) => sum + (typeof reasons[k] === "number" ? (reasons[k] as number) : 0), 0);
  return { score: Math.max(0, Math.min(100, score)), reasons };
}
