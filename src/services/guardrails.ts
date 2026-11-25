/** Pure checks for send_email, kept separate so they're unit-tested. */

export interface SendContext {
  sendingEnabled: boolean;
  draft: { kind: string; approvedAt: Date | null; approvedBy: string | null; approvedHash: string | null; contentHash: string; sentAt: Date | null; toAddress: string | null; toSetBy: string | null };
  accountStatus: string | null;
  sentTodayByAccount: number;
  maxPerDay: number;
  followUpCount: number;
  maxFollowUps: number;
  companyDomain: string | null;
  recipientTz: string | null;
  now: Date;
}

export function recipientAllowed(to: string, companyDomain: string | null, toSetBy: string | null): boolean {
  if (toSetBy === "wave") return true; // Wave typed it
  const domain = to.split("@")[1]?.toLowerCase().trim();
  if (!domain || !companyDomain) return false;
  const cd = companyDomain.toLowerCase();
  return domain === cd || domain.endsWith(`.${cd}`) || cd.endsWith(`.${domain}`);
}

export function hourIn(tz: string, at: Date): number | null {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(at));
  } catch {
    return null;
  }
}

/** Returns the reason a send must be refused, or null if it may go. */
export function refuseReason(c: SendContext): string | null {
  const d = c.draft;
  if (!c.sendingEnabled) return "sending is disabled (SENDING_ENABLED=false)";
  if (d.sentAt) return "draft was already sent";
  if (!d.approvedAt || d.approvedBy !== "wave") return "draft is not approved by Wave";
  if (d.approvedHash !== d.contentHash) return "draft was edited after approval; it needs a fresh approval";
  if (!d.toAddress) return "draft has no recipient";
  if (!recipientAllowed(d.toAddress, c.companyDomain, d.toSetBy)) return `recipient ${d.toAddress} doesn't match the company domain (${c.companyDomain ?? "unknown"}) and wasn't typed by Wave`;
  if (c.accountStatus !== "connected") return `sending account is ${c.accountStatus ?? "missing"}; reconnect it on the dashboard`;
  if (c.sentTodayByAccount >= c.maxPerDay) return `daily limit reached (${c.maxPerDay} sends for this account)`;
  if (d.kind === "follow_up" && c.followUpCount >= c.maxFollowUps) return `already sent ${c.followUpCount} follow-ups (max ${c.maxFollowUps})`;
  if (c.recipientTz) {
    const h = hourIn(c.recipientTz, c.now);
    if (h !== null && (h >= 22 || h < 7)) return `quiet hours for the recipient (${h}:00 in ${c.recipientTz}); try after 07:00 their time`;
  }
  return null;
}
