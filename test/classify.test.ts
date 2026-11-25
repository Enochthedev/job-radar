import { describe, expect, it } from "vitest";
import { classify } from "../src/filter/classify.js";
import { scoreJob } from "../src/filter/score.js";
import { loadProfile } from "../src/profile.js";
import { FIXTURES } from "./fixtures/jobs.js";

const profile = loadProfile("profile.yaml");

describe("gates on 20 hand-labelled jobs", () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      const c = classify(f.job, profile);
      expect(c.eligibility, c.eligibilityReason).toBe(f.eligibility);
      expect(c.rejectReason === null, c.rejectReason ?? "").toBe(f.pass);
    });
  }
});

describe("score", () => {
  it("rewards stack, domain, pay, freshness and worldwide", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    const { score, reasons } = scoreJob({
      title: "Backend Engineer", description: "TypeScript, Node.js, Postgres, Redis. Payments API. Seed-stage startup.",
      stack: ["typescript", "node", "postgres", "redis"], salaryMax: 90000, currency: "USD", salaryPeriod: "year",
      postedAt: new Date("2026-11-24T12:00:00Z"), remoteScope: "worldwide", onWatchlist: true,
    }, profile, now);
    expect(reasons.stack).toBe(30);
    expect(reasons.pay).toBe(15);
    expect(reasons.fresh).toBe(10);
    expect(score).toBeGreaterThanOrEqual(90);
    expect(score).toBeLessThanOrEqual(100);
  });
  it("scores a bare listing low", () => {
    expect(scoreJob({ title: "Software Engineer", stack: [] }, profile).score).toBeLessThan(20);
  });
});
