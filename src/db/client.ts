import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { config } from "../config.js";
import * as schema from "./schema.js";

let _sql: ReturnType<typeof postgres> | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function sql() {
  if (!_sql) _sql = postgres(config().DATABASE_URL, { max: 10, onnotice: () => {} });
  return _sql;
}

export function db() {
  if (!_db) _db = drizzle(sql(), { schema });
  return _db;
}

export async function logEvent(actor: "claude" | "owner" | "system", type: string, payload: Record<string, unknown> = {}) {
  await db().insert(schema.events).values({ actor, type, payload });
}
