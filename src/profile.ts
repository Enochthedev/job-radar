import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const Terms = z.object({ weight: z.number(), terms: z.array(z.string()) });

export const ProfileSchema = z.object({
  candidate: z.object({
    name: z.string(),
    citizenship: z.array(z.string()).default([]),
    work_authorisation: z.array(z.string()).default([]),
    github: z.string().optional(),
  }),
  home: z.object({ city: z.string(), country: z.string(), timezone: z.string(), utc_offset: z.number() }),
  eligibility: z.object({
    reject: z.array(z.string()),
    keep: z.array(z.string()),
    restricted_locations: z.array(z.string()),
    us_states: z.array(z.string()),
  }),
  roles: z.array(z.string()),
  title_exclude: z.array(z.string()).default([]),
  level: z.object({ reject_title: z.array(z.string()), reject_text: z.array(z.string()) }),
  score: z.object({
    stack: Terms,
    domain: Terms,
    pay: z.object({ weight: z.number(), floor_usd_year: z.number() }),
    stage: Terms,
    fresh: z.object({ weight: z.number(), hours: z.number() }),
    remote_worldwide: z.object({ weight: z.number() }),
    watchlist: z.object({ weight: z.number() }),
  }),
  shortlist: z.object({ size: z.number(), min_score: z.number() }),
  watchlist: z.array(z.object({
    name: z.string(),
    ats: z.enum(["greenhouse", "lever", "ashby"]),
    board: z.string(),
    yc: z.boolean().optional(),
  })).default([]),
  follow_up_days: z.array(z.number()).default([4, 10]),
  max_follow_ups: z.number().default(2),
});

export type Profile = z.infer<typeof ProfileSchema>;

let cached: { path: string; profile: Profile } | undefined;

export function loadProfile(path = process.env.PROFILE_PATH ?? "profile.yaml", fresh = false): Profile {
  if (!fresh && cached?.path === path) return cached.profile;
  const profile = ProfileSchema.parse(parse(readFileSync(path, "utf8")));
  cached = { path, profile };
  return profile;
}
