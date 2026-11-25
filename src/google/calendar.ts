import type { Account } from "../db/schema.js";
import { googleFetch } from "./oauth.js";

export async function createEvent(account: Account, e: { summary: string; start: Date; minutes: number; description?: string; location?: string }): Promise<{ id: string; htmlLink: string }> {
  return googleFetch(account, "https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    body: JSON.stringify({
      summary: e.summary,
      description: e.description,
      location: e.location,
      start: { dateTime: e.start.toISOString() },
      end: { dateTime: new Date(e.start.getTime() + e.minutes * 60_000).toISOString() },
      reminders: { useDefault: true },
    }),
  });
}
