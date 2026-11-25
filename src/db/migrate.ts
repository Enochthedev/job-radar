import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client.js";

export async function runMigrations() {
  // Postgres in compose can answer before it's really ready; retry for ~60s.
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate(db(), { migrationsFolder: "drizzle" });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (attempt >= 30 || (code && !["ECONNREFUSED", "57P03", "ECONNRESET", "ENOTFOUND"].includes(code))) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(async () => { console.log("migrations applied"); await sql().end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
