import { Queue, Worker } from "bullmq";
import { config, googleConfigured } from "../config.js";
import { logEvent } from "../db/client.js";
import { syncAllInboxes } from "../services/inbox.js";
import { refreshSources, rescoreAll } from "../services/ingest.js";
import { pollSheet, syncSheet } from "../services/sheet.js";
import { adapters } from "../sources/index.js";

const c = config();
const u = new URL(c.REDIS_URL);
const connection = { host: u.hostname, port: Number(u.port || 6379), password: u.password || undefined, maxRetriesPerRequest: null };
const QUEUE = "radar";
const queue = new Queue(QUEUE, { connection });

type Job = { kind: "source"; source: string } | { kind: "inbox" } | { kind: "sheet-poll" } | { kind: "sheet-sync" } | { kind: "rescore" };

async function schedule() {
  const every = (ms: number) => ({ every: ms });
  const H = 3600_000, M = 60_000;
  const opts = { removeOnComplete: 100, removeOnFail: 200, attempts: 3, backoff: { type: "exponential", delay: 30_000 } };
  for (const a of adapters()) {
    await queue.upsertJobScheduler(`source:${a.name}`, every(a.everyHours * H), { name: `source:${a.name}`, data: { kind: "source", source: a.name } satisfies Job, opts });
  }
  await queue.upsertJobScheduler("rescore", every(24 * H), { name: "rescore", data: { kind: "rescore" } satisfies Job, opts });
  if (googleConfigured()) {
    await queue.upsertJobScheduler("inbox", every(15 * M), { name: "inbox", data: { kind: "inbox" } satisfies Job, opts: { ...opts, attempts: 1 } });
    if (c.JOB_TRACKER_SHEET_ID) {
      await queue.upsertJobScheduler("sheet-poll", every(5 * M), { name: "sheet-poll", data: { kind: "sheet-poll" } satisfies Job, opts: { ...opts, attempts: 1 } });
      await queue.upsertJobScheduler("sheet-sync", every(30 * M), { name: "sheet-sync", data: { kind: "sheet-sync" } satisfies Job, opts: { ...opts, attempts: 1 } });
    }
  }
}

const worker = new Worker<Job>(QUEUE, async (job) => {
  const d = job.data;
  switch (d.kind) {
    case "source": return refreshSources(d.source);
    case "inbox": return syncAllInboxes();
    case "sheet-poll": return pollSheet();
    case "sheet-sync": return syncSheet();
    case "rescore": return rescoreAll();
  }
}, { connection, concurrency: 1 });

worker.on("completed", (j, r) => console.log(`[worker] ${j.name} done`, JSON.stringify(r).slice(0, 300)));
worker.on("failed", (j, e) => { console.error(`[worker] ${j?.name} failed: ${e.message}`); logEvent("system", "worker.failed", { job: j?.name, error: e.message.slice(0, 300) }).catch(() => {}); });

await schedule();
console.log("radar-worker started");

const stop = async () => { await worker.close(); await queue.close(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
