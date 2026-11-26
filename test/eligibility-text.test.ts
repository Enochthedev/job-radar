import { describe, expect, it } from "vitest";
import { classify } from "../src/filter/classify.js";
import { loadProfile } from "../src/profile.js";
import type { RawJob } from "../src/sources/types.js";

const p = loadProfile("profile.yaml");
const job = (locationRaw: string, description: string, title = "Senior Software Engineer"): RawJob =>
  ({ source: "t", externalId: description.slice(0, 20), url: "", company: "X", title, locationRaw, description });

// Real sentences from posts WWR tagged "Anywhere in the World" (Nov 2026).
describe("post text beats the board's location tag", () => {
  const restricted: [string, string][] = [
    ["WelcomeHome", "This role is fully remote (based in the U.S.) and reports to the CTO."],
    ["Oportun", "We're excited to consider talent currently based in India, as well as candidates open to relocating."],
    ["GitLab Poland", "As an Intermediate Backend Engineer, based in Poland, you'll build backend systems."],
    ["Airbnb", "If your position is employed by another Airbnb entity, your recruiter will inform you what states you are eligible to work from."],
    ["Smartsheet", "Requirements: • Legally eligible to work in the U.S. on an ongoing basis."],
    ["Postscript", "This position is fully remote and can be based in the US or Canada."],
    ["US-based", "We are looking for US-based engineers to join the platform team."],
  ];
  for (const [name, text] of restricted) {
    it(`rejects ${name}`, () => {
      const c = classify(job("Anywhere in the World", text), p);
      expect(c.eligibility, c.eligibilityReason).toBe("ineligible");
      expect(c.eligibilityReason).toMatch(/^post says/);
    });
  }

  const fine: [string, string][] = [
    ["cloud-based", "Familiarity with cloud-based infrastructure (AWS, GCP, or Azure)."],
    ["HQ", "Our headquarters are located in the Mission District of San Francisco, CA. We hire remotely."],
    ["salary note", "The base salary range for this role's listed level is currently for residents of the EU, applicable in the specified country only."],
    ["preference", "While we hire almost anywhere in the world, we have a preference for someone to reside in the following locations."],
    ["backgrounds", "We strongly encourage qualified candidates from all backgrounds to apply."],
    ["based in Africa", "Candidates must be based in Africa or Europe within UTC+0 to UTC+3."],
  ];
  for (const [name, text] of fine) {
    it(`keeps ${name}`, () => {
      const c = classify(job("Anywhere in the World", text), p);
      expect(c.eligibility, c.eligibilityReason).toBe("eligible");
    });
  }

  it("sends a contradiction to the LLM instead of guessing", () => {
    const c = classify(job("Remote", "You must be based in the US. Our team works worldwide."), p);
    expect(c.eligibility).toBe("unknown");
  });
  it("keeps 'US or anywhere in EMEA'", () => {
    expect(classify(job("Remote", "You can be based in the US, or anywhere in EMEA via Deel."), p).eligibility).toBe("eligible");
  });
});

describe("location tags", () => {
  it("rejects 'Asia Only'", () => expect(classify(job("Asia Only", "Great team."), p).eligibility).toBe("ineligible"));
  it("keeps 'Africa Only'", () => expect(classify(job("Africa Only", "Great team."), p).eligibility).toBe("eligible"));
  it("rejects AMER", () => expect(classify(job("Remote, AMER · Remote", "Join us."), p).eligibility).toBe("ineligible"));
  it("doesn't trust 'global' in a description", () => expect(classify(job("Remote", "We are a global company serving 10k customers."), p).eligibility).toBe("unknown"));
});

import { findSalary } from "../src/sources/salary.js";
describe("findSalary keeps the period", () => {
  it("monthly (Collabify)", () => expect(findSalary("Contract, 4–5 months | $3,000–4,000/month")).toMatchObject({ salaryMin: 3000, salaryMax: 4000, currency: "USD", salaryPeriod: "month" }));
  it("hourly", () => expect(findSalary("Full-time | $23-34/hr")).toMatchObject({ salaryMin: 23, salaryMax: 34, salaryPeriod: "hour" }));
  it("per hour words", () => expect(findSalary("Hourly Rate: $21.39 an hour")).toMatchObject({ salaryPeriod: "hour" }));
  it("k per year", () => expect(findSalary("Salary: $120k - $150k + equity")).toMatchObject({ salaryMin: 120000, salaryMax: 150000, salaryPeriod: "year" }));
  it("euros monthly", () => expect(findSalary("€4.000 to €5.500 per month")).toMatchObject({ salaryMin: 4000, salaryMax: 5500, currency: "EUR", salaryPeriod: "month" }));
});

import { visaLine } from "../src/sources/yc.js";
describe("YC visa field", () => {
  const yc = (visa: string) => classify(job("Remote", visaLine(visa), "Backend Engineer"), p);
  it("'US citizen/visa only' is ineligible", () => expect(yc("US citizen/visa only").eligibility).toBe("ineligible"));
  it("'not required' isn't read as a restriction", () => expect(yc("US citizenship/visa not required").eligibility).not.toBe("ineligible"));
  it("'Will sponsor' is eligible", () => expect(yc("Will sponsor").eligibility).toBe("eligible"));
});
