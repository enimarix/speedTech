import express from "express";
import { pool } from "./db.js";
import { migrate } from "./migrate.js";

const PORT = Number(process.env.PORT ?? 3000);

// db healthcheck in compose can still race the first query; retry briefly.
async function waitForDb(retries = 10): Promise<void> {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (e) {
      if (i === retries) throw e;
      console.log(`[db] not ready (${i}/${retries}), retrying...`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function main(): Promise<void> {
  await waitForDb();
  await migrate(pool);

  const app = express();
  // /health doubles as the M0 self-check: proves db reachable + migration seeded the registry.
  app.get("/health", async (_req, res) => {
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM engine_profiles",
    );
    res.json({ ok: true, engineProfiles: rows[0].count });
  });
  app.listen(PORT, () => console.log(`[app] listening on :${PORT}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
