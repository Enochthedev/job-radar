# Job Radar

One TypeScript MCP server that pulls remote jobs from public feeds, keeps only the ones the candidate can legally take from where they live, scores them, and tracks every application and email thread across several Gmail inboxes. Claude connects to it as a custom connector; Claude drafts, the owner approves, Job Radar sends.

**Rule that holds it together:** Claude can draft anything, but nothing leaves without an approval row written by the owner (tracker sheet or a dashboard using `DASHBOARD_TOKEN`). `approve` is not an MCP tool.

## Make it yours

Everything about the candidate lives in `profile.yaml`: `candidate` (name, citizenship, work authorisation, GitHub handle), `home` (city, timezone), the eligibility phrases, target roles, level rules, scoring weights, and the company watchlist. Connect your Gmail on `/dashboard`. The tracker sheet ("Job Radar Tracker", tab *Shortlist*) is created in your primary inbox's Drive on the first sync, so there's nothing to set up by hand. Set `JOB_TRACKER_SHEET_ID` only to reuse an existing sheet.

## Pieces

| Process | Entry | Does |
|---|---|---|
| `api` | `dist/api/index.js` | MCP endpoint (`/mcp`), dashboard API (`/api`), Google OAuth callbacks, `/dashboard` |
| `worker` | `dist/worker/index.js` | BullMQ: source polling, inbox sync (15 min), sheet poll (5 min), sheet push (30 min), daily rescore |
| `migrate` | `dist/db/migrate.js` | Drizzle migrations, runs once before the others |

Postgres 16 + Redis 7 stay on the private compose network. Nightly `pg_dump` lands in the `radar_backups` volume.

## Sources

HN Who is hiring (Algolia), RemoteOK, Remotive, Himalayas, We Work Remotely (RSS), a watchlist of company boards on Greenhouse / Lever / Ashby (`profile.yaml` `watchlist`), and **YC companies** read from their public YC company pages (`yc_directory`: the company list is the yc-oss daily mirror of YC's directory, filtered by region and topic; requests are sequential and spaced out). Each adapter returns the same `RawJob` shape (`src/sources/types.ts`), so a new board is one file. Boards that need a login (Work at a Startup, Wellfound, LinkedIn) are out of scope by design.

`add_job` takes any job URL: Greenhouse / Lever / Ashby and HN links go through their APIs; Getro boards (Techstars and many VC boards) and pages with schema.org `JobPosting` data are read directly; anything else (Notion, Google Forms, JS-only pages) is rendered with Jina Reader and read by the LLM. Board listings, application forms, closed roles and multi-role careers pages come back as a clear error with what to pass instead.

## Filtering

Three hard gates, then a 0–100 score. All rules live in `profile.yaml`.

1. **Eligibility:** structured board restrictions → reject phrases → **the post's own residency / work-authorisation wording** (beats board tags like "Anywhere in the World") → restricted locations → keep phrases; anything unclear goes to an LLM pass (OpenRouter, Haiku-class, fixed JSON schema), else `unknown` and flagged.
2. **Role:** title must match a target role.
3. **Level:** no staff/principal/junior titles, no "8+ years".

`pnpm test` checks 20 hand-labelled jobs plus every send guardrail.

## MCP tools

`search_jobs`, `get_job`, `add_job`, `refresh_sources`, `shortlist`, `save_draft`, `ready_to_send`, `send_email`, `update_status`, `inbox_digest`, `follow_ups_due`, `list_accounts`, `sync_sheet`, `stats`, `list_projects`.

Auth: `Authorization: Bearer $MCP_BEARER_TOKEN`, or `https://<host>/mcp/<token>` for clients (like claude.ai custom connectors) that only take a URL.

## Send guardrails (in code, `src/services/guardrails.ts`)

- refuses drafts without `approved_at`, approved by anyone but Wave, or edited after approval (content hash)
- 15 sends per account per day, 2 follow-ups per application, no sends 22:00–07:00 recipient time when known
- recipient must be at the company's domain unless Wave typed it
- `SENDING_ENABLED=false` stops everything
- every send / approval / refusal is in the append-only `events` table

## Deploy

```
rdk connect   # once
rdk up
```

Secrets go in `.env.remote.app` (see `.env.example`); never committed.
