import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db, logEvent } from "../db/client.js";
import { accounts, type Account } from "../db/schema.js";
import { decrypt, encrypt } from "./crypto.js";

export const MAIL_SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];
export const PRIMARY_EXTRA_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar.events",
];

export const redirectUri = () => `${config().PUBLIC_URL}/oauth/google/callback`;

export function authUrl(state: string, primary: boolean, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: config().GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent", // always get a refresh token
    include_granted_scopes: "true",
    scope: [...MAIL_SCOPES, ...(primary ? PRIMARY_EXTRA_SCOPES : [])].join(" "),
    state,
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

interface TokenResponse { access_token: string; expires_in: number; refresh_token?: string; scope: string; id_token?: string; error?: string; error_description?: string }

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config().GOOGLE_CLIENT_ID!, client_secret: config().GOOGLE_CLIENT_SECRET!, ...body }),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok) throw Object.assign(new Error(`token ${res.status}: ${json.error} ${json.error_description ?? ""}`), { oauthError: json.error });
  return json;
}

export async function completeOAuth(code: string, label?: string): Promise<Account> {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new Error("Google returned no refresh token; remove the app at myaccount.google.com/permissions and retry");
  const info = (await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${t.access_token}` } })).json()) as { email?: string };
  if (!info.email) throw new Error("could not read account email");
  const email = info.email.toLowerCase();
  const values = { provider: "google", email, label: label ?? null, tokenEnc: encrypt(t.refresh_token), scopes: t.scope.split(" "), status: "connected", connectedAt: new Date() };
  const [row] = await db().insert(accounts).values(values)
    .onConflictDoUpdate({ target: [accounts.provider, accounts.email], set: { ...values, label: label ?? undefined } })
    .returning();
  accessCache.delete(row.id);
  await logEvent("wave", "account.connected", { email, scopes: values.scopes });
  return row;
}

const accessCache = new Map<number, { token: string; exp: number }>();

export class AccountExpiredError extends Error {}

export async function accessToken(account: Account): Promise<string> {
  const hit = accessCache.get(account.id);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  if (!account.tokenEnc) throw new AccountExpiredError(`${account.email} has no token`);
  try {
    const t = await tokenRequest({ refresh_token: decrypt(account.tokenEnc), grant_type: "refresh_token" });
    accessCache.set(account.id, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
    return t.access_token;
  } catch (err) {
    if ((err as { oauthError?: string }).oauthError === "invalid_grant") {
      // Testing-mode refresh tokens lapse after 7 days. Flag it so the dashboard shows Reconnect.
      await db().update(accounts).set({ status: "expired" }).where(eq(accounts.id, account.id));
      await logEvent("system", "account.expired", { email: account.email });
      throw new AccountExpiredError(`${account.email} needs reconnecting`);
    }
    throw err;
  }
}

export async function findAccount(ref: string | number | null | undefined): Promise<Account | undefined> {
  if (ref === null || ref === undefined || ref === "") return undefined;
  const all = await db().select().from(accounts).where(eq(accounts.provider, "google"));
  const s = String(ref).toLowerCase();
  return all.find((a) => String(a.id) === s || a.email === s || a.label?.toLowerCase() === s);
}

export async function primaryAccount(): Promise<Account | undefined> {
  const email = config().PRIMARY_ACCOUNT_EMAIL?.toLowerCase();
  const rows = await db().select().from(accounts).where(and(eq(accounts.provider, "google"), eq(accounts.status, "connected")));
  return (email ? rows.find((a) => a.email === email) : undefined)
    ?? rows.find((a) => a.scopes.some((s) => s.endsWith("/spreadsheets")));
}

export async function googleFetch<T>(account: Account, url: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(account);
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) accessCache.delete(account.id);
  if (!res.ok) throw new Error(`Google ${init.method ?? "GET"} ${url.split("?")[0]} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}
