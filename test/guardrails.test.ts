import { describe, expect, it } from "vitest";
import { recipientAllowed, refuseReason, type SendContext } from "../src/services/guardrails.js";

const base = (): SendContext => ({
  sendingEnabled: true,
  draft: { kind: "cold_email", approvedAt: new Date(), approvedBy: "wave", approvedHash: "h", contentHash: "h", sentAt: null, toAddress: "jobs@acme.com", toSetBy: "claude" },
  accountStatus: "connected", sentTodayByAccount: 0, maxPerDay: 15, followUpCount: 0, maxFollowUps: 2,
  companyDomain: "acme.com", recipientTz: null, now: new Date("2026-11-25T12:00:00Z"),
});

describe("send_email guardrails", () => {
  it("allows an approved, unedited draft", () => expect(refuseReason(base())).toBeNull());
  it("refuses unapproved", () => { const c = base(); c.draft.approvedAt = null; expect(refuseReason(c)).toMatch(/not approved/); });
  it("refuses approval by anyone but Wave", () => { const c = base(); c.draft.approvedBy = "claude"; expect(refuseReason(c)).toMatch(/not approved/); });
  it("refuses edited after approval", () => { const c = base(); c.draft.contentHash = "h2"; expect(refuseReason(c)).toMatch(/edited after approval/); });
  it("refuses when kill switch is off", () => { const c = base(); c.sendingEnabled = false; expect(refuseReason(c)).toMatch(/disabled/); });
  it("refuses at the daily cap", () => { const c = base(); c.sentTodayByAccount = 15; expect(refuseReason(c)).toMatch(/daily limit/); });
  it("refuses a third follow-up", () => { const c = base(); c.draft.kind = "follow_up"; c.followUpCount = 2; expect(refuseReason(c)).toMatch(/follow-ups/); });
  it("refuses wrong-domain recipient set by Claude", () => { const c = base(); c.draft.toAddress = "ceo@gmail.com"; expect(refuseReason(c)).toMatch(/doesn't match/); });
  it("allows any recipient Wave typed", () => { const c = base(); c.draft.toAddress = "ceo@gmail.com"; c.draft.toSetBy = "wave"; expect(refuseReason(c)).toBeNull(); });
  it("refuses during recipient quiet hours", () => { const c = base(); c.recipientTz = "America/Los_Angeles"; c.now = new Date("2026-11-25T08:00:00Z"); expect(refuseReason(c)).toMatch(/quiet hours/); });
  it("refuses expired account", () => { const c = base(); c.accountStatus = "expired"; expect(refuseReason(c)).toMatch(/reconnect/); });
  it("matches subdomains", () => { expect(recipientAllowed("a@mail.acme.com", "acme.com", "claude")).toBe(true); expect(recipientAllowed("a@acme.co", "acme.com", "claude")).toBe(false); });
});
