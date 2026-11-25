import type { Profile } from "../profile.js";
import type { RawJob } from "../sources/types.js";

export type Eligibility = "eligible" | "ineligible" | "unknown";

export interface Classification {
  eligibility: Eligibility;
  eligibilityReason: string;
  remoteScope: "worldwide" | "regional" | "restricted" | "unclear";
  roleOk: boolean;
  levelOk: boolean;
  /** Set when a hard gate fails (eligibility=ineligible, role, or level). */
  rejectReason: string | null;
  stack: string[];
  level: string | null;
}

const rx = (p: string) => new RegExp(p, "i");
const wordRx = (w: string) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
const firstMatch = (patterns: string[], text: string) => patterns.find((p) => rx(p).test(text));

const WORLDWIDE = /worldwide|anywhere|\bglobal(ly)?\b|all countries|any location|work from anywhere/i;
const LAGOS_TZ_OFFSETS = [0, 1, 2, 3];

export function eligibilityOf(job: RawJob, profile: Profile): Pick<Classification, "eligibility" | "eligibilityReason" | "remoteScope"> {
  const e = profile.eligibility;
  const loc = (job.locationRaw ?? "").trim();
  const head = `${loc}\n${(job.tags ?? []).join(" ")}\n${(job.description ?? "").slice(0, 4000)}`;

  // 1. Structured restrictions from the board beat free text.
  if (job.locationRestrictions && job.locationRestrictions.length) {
    const ok = job.locationRestrictions.find((l) => firstMatch(e.keep, l));
    if (!ok) return { eligibility: "ineligible", eligibilityReason: `restricted to ${job.locationRestrictions.join(", ")}`, remoteScope: "restricted" };
  }
  if (job.timezoneRestrictions && job.timezoneRestrictions.length && !job.timezoneRestrictions.some((t) => LAGOS_TZ_OFFSETS.includes(t))) {
    return { eligibility: "ineligible", eligibilityReason: `timezones ${job.timezoneRestrictions.join(",")} exclude UTC+1`, remoteScope: "restricted" };
  }

  // 2. Explicit reject phrases anywhere in location/tags/description head.
  const rejectHit = firstMatch(e.reject, head);
  if (rejectHit) return { eligibility: "ineligible", eligibilityReason: `matched "${rejectHit}"`, remoteScope: "restricted" };

  // 3. A location made of restricted countries / US states, with no keep words, is a restriction.
  const locKeep = firstMatch(e.keep, loc);
  if (loc && !locKeep) {
    const place = [...e.restricted_locations, ...e.us_states].find((p) => wordRx(p).test(loc));
    if (place) return { eligibility: "ineligible", eligibilityReason: `location "${loc}" (${place})`, remoteScope: "restricted" };
  }

  // 4. Keep phrases → eligible.
  if (locKeep) {
    return { eligibility: "eligible", eligibilityReason: `location "${loc}"`, remoteScope: WORLDWIDE.test(loc) ? "worldwide" : "regional" };
  }
  const keepHit = firstMatch(e.keep, head);
  if (keepHit) {
    return { eligibility: "eligible", eligibilityReason: `matched "${keepHit}"`, remoteScope: WORLDWIDE.test(head) ? "worldwide" : "regional" };
  }
  return { eligibility: "unknown", eligibilityReason: loc ? `unclear location "${loc}"` : "no location given", remoteScope: "unclear" };
}

export function roleOf(title: string, profile: Profile): boolean {
  if (firstMatch(profile.title_exclude, title)) return false;
  return Boolean(firstMatch(profile.roles, title));
}

export function levelOf(job: RawJob, profile: Profile): { ok: boolean; level: string | null; reason?: string } {
  const t = job.title;
  const titleHit = firstMatch(profile.level.reject_title, t);
  if (titleHit) return { ok: false, level: /staff|principal|distinguished|architect/i.test(t) ? "staff+" : "junior", reason: `title "${titleHit}"` };
  const textHit = firstMatch(profile.level.reject_text, job.description ?? "");
  if (textHit) return { ok: false, level: "staff+", reason: `requires ${textHit}` };
  const level = /\bsenior\b|\bsr\.?\b/i.test(t) ? "senior" : /\blead\b/i.test(t) ? "lead" : /\bmid\b/i.test(t) ? "mid" : null;
  return { ok: true, level };
}

const STACK_TERMS: [string, RegExp][] = [
  ["typescript", /typescript|\bts\b/i],
  ["node", /node\.?js|\bnode\b|nestjs|express/i],
  ["go", /golang|\bGo\b(?!ogle)/],
  ["postgres", /postgres|postgresql|\bpg\b/i],
  ["redis", /\bredis\b/i],
  ["python", /\bpython\b|django|fastapi/i],
  ["react", /\breact\b|next\.?js/i],
  ["rust", /\brust\b/i],
  ["aws", /\baws\b|amazon web services/i],
  ["kubernetes", /kubernetes|\bk8s\b/i],
];

export function stackOf(job: RawJob): string[] {
  const text = `${job.title}\n${(job.tags ?? []).join(" ")}\n${job.description ?? ""}`;
  return STACK_TERMS.filter(([, r]) => r.test(text)).map(([n]) => n);
}

export function classify(job: RawJob, profile: Profile): Classification {
  const elig = eligibilityOf(job, profile);
  const roleOk = roleOf(job.title, profile);
  const lvl = levelOf(job, profile);
  const rejectReason =
    elig.eligibility === "ineligible" ? `eligibility: ${elig.eligibilityReason}` :
    !roleOk ? "role: title not a target role" :
    !lvl.ok ? `level: ${lvl.reason}` : null;
  return { ...elig, roleOk, levelOk: lvl.ok, rejectReason, stack: stackOf(job), level: lvl.level };
}
