import { getPool } from "./db";

/** In-process marker for the run this server is currently executing (survives Next.js HMR). */
const g = globalThis as unknown as { __indexRunId?: number | null };

export function getActiveRunId(): number | null {
  return g.__indexRunId ?? null;
}

export function setActiveRunId(id: number | null): void {
  g.__indexRunId = id;
}

/**
 * Rows still marked "running" that this process isn't executing were interrupted (server restart/crash):
 * mark them as errored so the status page never shows a run that can't finish.
 */
export async function failStaleRuns(): Promise<void> {
  const active = getActiveRunId();
  await getPool().query(
    `UPDATE indexing_runs
        SET status = 'error', finished_at = now(),
            per_repo_progress = per_repo_progress || '{"(run)": {"stage": "error", "stages": {}, "error": "Run interrupted (server restarted before it finished)"}}'::jsonb
      WHERE status = 'running' AND ($1::bigint IS NULL OR id <> $1)`,
    [active],
  );
}
