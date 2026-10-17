import type { Sql } from "postgres";

export type JobKind = "classify" | "dispatch" | "reconcile";

export type Job = {
  id: string;
  kind: JobKind;
  ticketId: string;
  dispatchId: string | null;
  attempts: number;
  maxAttempts: number;
};

// A handler commits its own result and follow-up jobs; the runner only
// records whether it threw.
export type Handlers = Partial<Record<JobKind, (job: Job) => Promise<void>>>;

export const LEASE_MS = 2 * 60_000;

// 5s, 10s, 20s, … capped at 5 min.
export function exponentialBackoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** (attempts - 1), 300_000);
}

type RunOptions = {
  sql: Sql;
  workerId: string;
  handlers: Handlers;
  backoffMs?: (attempts: number) => number;
};

type Row = {
  id: string;
  kind: JobKind;
  ticket_id: string;
  dispatch_id: string | null;
  attempts: number;
  max_attempts: number;
};

async function claimJob(
  sql: Sql,
  workerId: string,
  kinds: JobKind[],
): Promise<Job | null> {
  const lease = `${LEASE_MS} milliseconds`;
  return sql.begin(async (tx) => {
    // A lease that expired with no attempts left is not retried forever.
    await tx`
      update jobs
      set status = 'dead', locked_at = null, locked_by = null,
          last_error = 'lease expired with no attempts left'
      where kind = any(${kinds}::job_kind[]) and status = 'running'
        and locked_at < now() - ${lease}::interval
        and attempts >= max_attempts`;
    const [row] = await tx<Row[]>`
      update jobs
      set status = 'running', attempts = attempts + 1,
          locked_at = now(), locked_by = ${workerId}
      where id = (
        select id from jobs
        where kind = any(${kinds}::job_kind[])
          and ((status = 'queued' and run_at <= now())
            or (status = 'running' and locked_at < now() - ${lease}::interval))
        order by run_at
        for update skip locked
        limit 1)
      returning id, kind, ticket_id, dispatch_id, attempts, max_attempts`;
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      ticketId: row.ticket_id,
      dispatchId: row.dispatch_id,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };
  });
}

// Runs at most one job. Resolves to whether a job was claimed.
export async function runNextJob({
  sql,
  workerId,
  handlers,
  backoffMs = exponentialBackoffMs,
}: RunOptions): Promise<boolean> {
  const kinds = Object.keys(handlers) as JobKind[];
  const job = await claimJob(sql, workerId, kinds);
  if (!job) return false;

  try {
    await handlers[job.kind]!(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dead = job.attempts >= job.maxAttempts;
    const delay = `${dead ? 0 : backoffMs(job.attempts)} milliseconds`;
    await sql`
      update jobs
      set status = ${dead ? "dead" : "queued"}::job_status,
          run_at = case when ${dead} then run_at else now() + ${delay}::interval end,
          last_error = ${message}, locked_at = null, locked_by = null
      where id = ${job.id} and locked_by = ${workerId}`;
    return true;
  }
  await sql`
    update jobs
    set status = 'done', locked_at = null, locked_by = null
    where id = ${job.id} and locked_by = ${workerId}`;
  return true;
}
