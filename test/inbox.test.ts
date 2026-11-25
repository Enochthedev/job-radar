import { describe, expect, it } from "vitest";
import { parseSince } from "../src/services/inbox.js";

describe("parseSince", () => {
  it("accepts relative hours and days", () => {
    const h = Date.now() - parseSince("72h", 0).getTime();
    expect(Math.round(h / 3600_000)).toBe(72);
    const d = Date.now() - parseSince("3d", 0).getTime();
    expect(Math.round(d / 86400_000)).toBe(3);
  });
  it("accepts ISO and falls back when empty", () => {
    expect(parseSince("2026-11-23T00:00:00Z", 0).toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(Math.round((Date.now() - parseSince(undefined, 86400_000).getTime()) / 3600_000)).toBe(24);
  });
  it("rejects junk with a clear message", () => {
    expect(() => parseSince("yesterday", 0)).toThrow(/ISO time/);
  });
});
