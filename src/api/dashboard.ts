import type { Account } from "../db/schema.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Minimal built-in page: connect/reconnect inboxes. The full dashboard lives in the HQ app. */
export function dashboardHtml(o: { accounts: Account[]; sendingEnabled: boolean; googleConfigured: boolean; sheetConfigured: boolean }) {
  const rows = o.accounts.map((a) => `<tr><td>${esc(a.email)}</td><td>${esc(a.label ?? "")}</td>
    <td class="${a.status === "connected" ? "ok" : "bad"}">${esc(a.status)}</td>
    <td>${a.lastSyncAt ? esc(a.lastSyncAt.toISOString().replace("T", " ").slice(0, 16)) : "—"}</td>
    <td><a class="btn" href="/oauth/google/start?hint=${encodeURIComponent(a.email)}${a.scopes.some((s) => s.endsWith("/spreadsheets")) ? "&primary=1" : ""}&label=${encodeURIComponent(a.label ?? "")}">Reconnect</a></td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Job Radar</title>
<style>
:root{--bg:#f7fafa;--fg:#0f2a2e;--muted:#5b7376;--line:#d9e4e5;--accent:#0f766e;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0b1517;--fg:#e3eeee;--muted:#8aa3a5;--line:#1f3236;--accent:#2dd4bf;--bad:#f97066}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}p{color:var(--muted);margin:0 0 24px}
table{width:100%;border-collapse:collapse;margin:16px 0}td,th{text-align:left;padding:8px;border-bottom:1px solid var(--line)}
.ok{color:var(--accent)}.bad{color:var(--bad)}.btn{display:inline-block;padding:6px 12px;border:1px solid var(--accent);border-radius:8px;color:var(--accent);text-decoration:none}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;border:1px solid var(--line);margin-right:8px;font-size:13px}
</style></head><body>
<h1>Job Radar</h1><p>Inbox connections. Approvals and the pipeline live in the HQ app and the Job Tracker sheet.</p>
<span class="pill">Sending: <b class="${o.sendingEnabled ? "ok" : "bad"}">${o.sendingEnabled ? "on" : "off"}</b></span>
<span class="pill">Google OAuth: <b class="${o.googleConfigured ? "ok" : "bad"}">${o.googleConfigured ? "configured" : "missing"}</b></span>
<span class="pill">Tracker sheet: <b class="${o.sheetConfigured ? "ok" : "bad"}">${o.sheetConfigured ? "ready" : "created on first sync"}</b></span>
<table><thead><tr><th>Inbox</th><th>Label</th><th>Status</th><th>Last sync</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="5">No inboxes yet.</td></tr>`}</tbody></table>
${o.googleConfigured ? `<a class="btn" href="/oauth/google/start?primary=1&label=primary">Connect primary (mail + sheet + calendar)</a> &nbsp;
<a class="btn" href="/oauth/google/start?label=cv">Connect another inbox (mail only)</a>` : ""}
</body></html>`;
}
