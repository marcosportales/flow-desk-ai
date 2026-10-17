import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { classifierFromEnv } from "@/infra/classifier";
import { getDb, getSql } from "@/infra/db/client";
import { classifyTicket } from "@/services/classifyTicket";
import {
  exponentialBackoffMs,
  type Handlers,
  type JobKind,
  runNextJob,
} from "./runner";

const IDLE_MS = 1000;
const TICK_MS = 10_000;
// Touched every loop; the compose healthcheck reads its mtime.
const HEARTBEAT_FILE = "/tmp/worker-heartbeat";

// Fails at start-up on a bad CLASSIFIER / LLM_* configuration.
const classifier = classifierFromEnv(process.env);
const db = getDb();

// Registered as they land (dispatch: SCRUM-13). The worker only claims kinds
// that have a handler, so jobs of the others wait in the queue untouched.
const handlers: Handlers = {
  classify: (job) => classifyTicket(db, classifier, job),
};

// Classify retries after a provider error: 2s, 8s, 30s (IMPLEMENTATION.md §2.5).
const backoffMs = (attempts: number, kind: JobKind) =>
  kind === "classify"
    ? ([2_000, 8_000, 30_000][attempts - 1] ?? 30_000)
    : exponentialBackoffMs(attempts);

// Marks `sent` Dispatches past their callback deadline `unknown` and enqueues
// a reconcile job; wired up with the Dispatch handlers.
async function sweepCallbackDeadlines(): Promise<void> {}

const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const sql = getSql();

let running = true;
let wake: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
    wake?.();
  });
}

// Sleeps, but a shutdown signal cuts it short.
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });

console.log(`${workerId} started`);
let nextTickAt = 0;
while (running) {
  await writeFile(HEARTBEAT_FILE, String(Date.now()));

  if (Date.now() >= nextTickAt) {
    nextTickAt = Date.now() + TICK_MS;
    await sweepCallbackDeadlines().catch((error) =>
      console.error("tick failed", error),
    );
  }

  // The loop must outlive a single bad job or a database blip.
  const ranJob = await runNextJob({ sql, workerId, handlers, backoffMs }).catch(
    (error) => {
      console.error("job loop failed", error);
      return false;
    },
  );
  // Back-to-back while there is work; sleep when idle.
  if (!ranJob) await sleep(IDLE_MS);
}

// The in-flight job (if any) has finished by here: the loop only checks
// `running` between jobs.
await sql.end({ timeout: 5 });
console.log(`${workerId} stopped`);
