import type { Account } from "../db/schema.js";
import { htmlToText } from "../text.js";
import { googleFetch } from "./oauth.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface Part { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number }; parts?: Part[] }
export interface GmailMessage { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part }

export interface ParsedMessage {
  id: string;
  threadId: string;
  from: string;
  fromEmail: string;
  to: string;
  subject: string;
  messageIdHeader: string | null;
  date: Date;
  snippet: string;
  text: string; // plain text only — raw HTML never leaves this module
  isSent: boolean;
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function findPart(p: Part | undefined, mime: string): Part | undefined {
  if (!p) return;
  if (p.mimeType === mime && p.body?.data) return p;
  for (const c of p.parts ?? []) { const f = findPart(c, mime); if (f) return f; }
}

export function parseMessage(m: GmailMessage): ParsedMessage {
  const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const plain = findPart(m.payload, "text/plain");
  const html = findPart(m.payload, "text/html");
  let text = plain?.body?.data ? b64(plain.body.data) : html?.body?.data ? htmlToText(b64(html.body.data)) : (m.snippet ?? "");
  // Drop quoted history so matching/LLM only sees the new reply.
  text = text.split(/\n(?:On .{5,120}wrote:|-{2,} ?Original Message|From: .+\nSent: )/)[0].trim();
  const from = h("From");
  return {
    id: m.id,
    threadId: m.threadId,
    from,
    fromEmail: (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase(),
    to: h("To"),
    subject: h("Subject"),
    messageIdHeader: h("Message-ID") || h("Message-Id") || null,
    date: new Date(Number(m.internalDate ?? Date.now())),
    snippet: htmlToText(m.snippet ?? "").slice(0, 300),
    text: text.slice(0, 8000),
    isSent: (m.labelIds ?? []).includes("SENT"),
  };
}

export async function listMessageIds(account: Account, q: string, max = 200): Promise<{ id: string; threadId: string }[]> {
  const out: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ q, maxResults: "100" });
    if (pageToken) p.set("pageToken", pageToken);
    const r = await googleFetch<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(account, `${BASE}/messages?${p}`);
    out.push(...(r.messages ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

export async function getMessage(account: Account, id: string): Promise<ParsedMessage> {
  return parseMessage(await googleFetch<GmailMessage>(account, `${BASE}/messages/${id}?format=full`));
}

function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

export interface OutgoingEmail { from: string; to: string; subject: string; body: string; inReplyTo?: string | null; threadId?: string | null }

export function buildRaw(e: OutgoingEmail): string {
  const headers = [
    `From: ${e.from}`,
    `To: ${e.to}`,
    `Subject: ${encodeHeader(e.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  if (e.inReplyTo) headers.push(`In-Reply-To: ${e.inReplyTo}`, `References: ${e.inReplyTo}`);
  const body = Buffer.from(e.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`).toString("base64url");
}

export async function sendMessage(account: Account, e: OutgoingEmail): Promise<{ id: string; threadId: string }> {
  return googleFetch(account, `${BASE}/messages/send`, {
    method: "POST",
    body: JSON.stringify({ raw: buildRaw(e), ...(e.threadId ? { threadId: e.threadId } : {}) }),
  });
}
