import { afterAll, describe, expect, it } from "vitest";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

describe.skipIf(!process.env.DATABASE_URL)("stale run handling", () => {
  afterAll(async () => {
    const { closePool } = await import("../lib/db");
    await closePool();
  });

  it("marks interrupted 'running' rows as errored but spares the active run", async () => {
    const { getPool } = await import("../lib/db");
    const { failStaleRuns, setActiveRunId } = await import("../lib/indexRuns");
    const pool = getPool();
    const stale = Number((await pool.query("INSERT INTO indexing_runs (status) VALUES ('running') RETURNING id")).rows[0].id);
    const live = Number((await pool.query("INSERT INTO indexing_runs (status) VALUES ('running') RETURNING id")).rows[0].id);
    try {
      setActiveRunId(live);
      await failStaleRuns();
      const rows = (await pool.query("SELECT id, status, finished_at, per_repo_progress FROM indexing_runs WHERE id = ANY($1)", [[stale, live]])).rows;
      const get = (id: number) => rows.find((r) => Number(r.id) === id);
      expect(get(stale).status).toBe("error");
      expect(get(stale).finished_at).not.toBeNull();
      expect(get(stale).per_repo_progress["(run)"].error).toMatch(/interrupted/i);
      expect(get(live).status).toBe("running");
    } finally {
      setActiveRunId(null);
      await pool.query("DELETE FROM indexing_runs WHERE id = ANY($1)", [[stale, live]]);
    }
  });
});
