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

const RESIDENCY: RegExp[] = [
  /\b(?:based|located|residing|reside|live|living|resident(?:s)?|domiciled)\s+(?:in|within|of)\s+((?:[^.;\n]|\.(?!\s|$)){0,70})/gi,
  /\b(?:eligible|authori[sz]ed|permitted|legally able|right)\s+to\s+work\s+(?:in|from|within)\s+((?:[^.;\n]|\.(?!\s|$)){0,70})/gi,
  /\bopen (?:only )?to (?:candidates|applicants|people|talent) (?:in|from|located in|based in)\s+((?:[^.;\n]|\.(?!\s|$)){0,70})/gi,
  /\bonly (?:hire|hiring|accept\w*|consider\w*)\s+(?:candidates |applicants |people |talent )?(?:in|from|based in|located in)\s+((?:[^.;\n]|\.(?!\s|$)){0,70})/gi,
  /\bcan (?:only )?(?:hire|employ) (?:in|from)\s+((?:[^.;\n]|\.(?!\s|$)){0,70})/gi,
];
// Wording that mentions a place without restricting who can apply.
const NOT_A_RESTRICTION = /(headquarter|\bhq\b|office|offices|founded|our team (?:is|are)|we(?:'re| are) (?:a|an)|salary|compensation|pay range|base pay|range for|prefer|preference|ideally|bonus|nice to have|customers|clients|users)/i;

export interface TextRestriction { place: string; snippet: string }

/**
 * Finds a residency / work-authorisation restriction stated in the post itself
 * ("based in the US", "eligible to work in Canada", "US-based"). Board location tags
 * like "Anywhere in the World" are often wrong; the post's own words win.
 */
export function textRestriction(text: string, profile: Profile): TextRestriction | null {
  const e = profile.eligibility;
  const places = [...e.restricted_locations, ...e.us_states];
  const t = text.slice(0, 12000);
  if (/states you are eligible to work from|work from (?:one of )?(?:the following|these) (?:us |u\.s\. )?states/i.test(t)) return { place: "US states", snippet: "states you are eligible to work from" };
  const flag = /\b(us|u\.s\.?|usa|uk|eu|canada|americas?|europe|latam|india)[- ](?:based|only)\b/i.exec(t);
  if (flag && !NOT_A_RESTRICTION.test(t.slice(Math.max(0, flag.index - 50), flag.index))) return { place: flag[1], snippet: flag[0] };
  for (const rx of RESIDENCY) {
    rx.lastIndex = 0;
    for (let m = rx.exec(t); m; m = rx.exec(t)) {
      const before = t.slice(Math.max(0, m.index - 60), m.index);
      const span = m[1];
      if (NOT_A_RESTRICTION.test(before) || NOT_A_RESTRICTION.test(m[0].slice(0, 30))) continue;
      if (firstMatch(e.keep, span)) continue; // "based in Africa / EMEA / anywhere"
      const place = places.find((p) => wordRx(p).test(span));
      if (place) return { place, snippet: m[0].trim().slice(0, 120) };
    }
  }
  return null;
}

function homeOffsets(p: Profile): number[] {
  const h = Math.round(p.home.utc_offset);
  return [h - 1, h, h + 1, h + 2];
}

export function eligibilityOf(job: RawJob, profile: Profile): Pick<Classification, "eligibility" | "eligibilityReason" | "remoteScope"> {
  const e = profile.eligibility;
  const loc = (job.locationRaw ?? "").trim();
  const desc = job.description ?? "";
  const head = `${loc}\n${(job.tags ?? []).join(" ")}\n${desc.slice(0, 4000)}`;
  const strongKeep = e.keep.filter((k) => !e.location_only_keep.includes(k));

  // 1. Structured restrictions from the board.
  if (job.locationRestrictions && job.locationRestrictions.length) {
    const ok = job.locationRestrictions.find((l) => firstMatch(e.keep, l));
    if (!ok) return { eligibility: "ineligible", eligibilityReason: `restricted to ${job.locationRestrictions.join(", ")}`, remoteScope: "restricted" };
  }
  if (job.timezoneRestrictions && job.timezoneRestrictions.length && !job.timezoneRestrictions.some((t) => homeOffsets(profile).includes(t))) {
    return { eligibility: "ineligible", eligibilityReason: `timezones ${job.timezoneRestrictions.join(",")} exclude ${profile.home.timezone}`, remoteScope: "restricted" };
  }

  // 2. Explicit reject phrases anywhere in location/tags/description head.
  const rejectHit = firstMatch(e.reject, head);
  if (rejectHit) return { eligibility: "ineligible", eligibilityReason: `matched "${rejectHit}"`, remoteScope: "restricted" };

  // 3. The post's own residency / work-authorisation wording beats any board tag.
  const tr = textRestriction(desc, profile);
  if (tr) {
    const alsoOpen = firstMatch(strongKeep, desc);
    if (alsoOpen) return { eligibility: "unknown", eligibilityReason: `post says "${tr.snippet}" but also "${alsoOpen}"`, remoteScope: "unclear" };
    return { eligibility: "ineligible", eligibilityReason: `post says "${tr.snippet}"`, remoteScope: "restricted" };
  }

  // 4. Location tags: "Asia Only", or restricted places with no keep words.
  const locKeep = firstMatch(e.keep, loc);
  const only = loc.match(/^\s*([a-z .,&/-]+?)\s+only\b/i);
  if (only && !firstMatch(e.keep, only[1])) return { eligibility: "ineligible", eligibilityReason: `location "${loc}"`, remoteScope: "restricted" };
  if (loc && !locKeep) {
    const place = [...e.restricted_locations, ...e.us_states].find((p) => wordRx(p).test(loc));
    if (place) return { eligibility: "ineligible", eligibilityReason: `location "${loc}" (${place})`, remoteScope: "restricted" };
  }

  // 5. Keep phrases. Loose words ("global", "anywhere") only count in the location field.
  if (locKeep) {
    return { eligibility: "eligible", eligibilityReason: `location "${loc}"`, remoteScope: WORLDWIDE.test(loc) ? "worldwide" : "regional" };
  }
  const keepHit = firstMatch(strongKeep, head);
  if (keepHit) {
    return { eligibility: "eligible", eligibilityReason: `matched "${keepHit}"`, remoteScope: /worldwide|anywhere in the world/i.test(head) ? "worldwide" : "regional" };
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
