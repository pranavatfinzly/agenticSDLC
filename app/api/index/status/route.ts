import { NextResponse } from "next/server";
import { getPool } from "../../../../lib/db";
import { failStaleRuns } from "../../../../lib/indexRuns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get("runId");
  await failStaleRuns();
  const pool = getPool();
  const { rows } = runId
    ? await pool.query("SELECT * FROM indexing_runs WHERE id = $1", [runId])
    : await pool.query("SELECT * FROM indexing_runs ORDER BY id DESC LIMIT 1");
  if (!rows.length) return NextResponse.json({ run: null });
  const r = rows[0];
  return NextResponse.json({
    run: {
      id: Number(r.id),
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      perRepoProgress: r.per_repo_progress,
    },
  });
}
