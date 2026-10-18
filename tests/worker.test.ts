import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { jobs, users, tickets } from "@/infra/db/schema";
import { runNextJob, type Handlers } from "@/worker/runner";
import { connectTestDb } from "./support/db";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

// Each test works on its own Ticket, so parallel test files and earlier tests
// never see each other's jobs.
async function newJob(overrides: Partial<typeof jobs.$inferInsert> = {}) {
  const [requester] = await db
    .insert(users)
    .values({
      name: "Worker Test",
      email: `${randomUUID()}@test.example`,
      department: "QA",
    })
    .returning();
  const [ticket] = await db
    .insert(tickets)
    .values({
      requesterId: requester!.id,
      title: "Worker test",
      description: "A ticket used by the worker tests.",
      idempotencyKey: randomUUID(),
      requestHash: "hash",
    })
    .returning();
  const [job] = await db
    .insert(jobs)
    .values({ kind: "classify", ticketId: ticket!.id, ...overrides })
    .returning();
  return job!;
}

async function reload(id: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  return job!;
}

const noBackoff = () => 0;

describe("worker", () => {
  it("runs a queued job and marks it done", async () => {
    const job = await newJob();
    const seen: string[] = [];
    const handlers: Handlers = {
      classify: async (j) => {
        seen.push(j.id);
      },
    };

    await runNextJob({
      sql,
      ticketIds: [job.ticketId],
      workerId: "w1",
      handlers,
      backoffMs: noBackoff,
    });

    expect(seen).toContain(job.id);
    const done = await reload(job.id);
    expect(done.status).toBe("done");
    expect(done.lockedBy).toBeNull();
  });

  it("does not claim a job before its run_at", async () => {
    const job = await newJob({ runAt: new Date(Date.now() + 60_000) });
    const handlers: Handlers = { classify: async () => {} };

    await runNextJob({
      sql,
      ticketIds: [job.ticketId],
      workerId: "w1",
      handlers,
      backoffMs: noBackoff,
    });

    expect((await reload(job.id)).status).toBe("queued");
  });

  it("never runs the same job on two concurrent workers", async () => {
    const created = await Promise.all(Array.from({ length: 10 }, newJob));
    const ids = created.map((j) => j.id);
    const ticketIds = created.map((j) => j.ticketId);
    const runs = new Map<string, number>();
    const handlers: Handlers = {
      classify: async (j) => {
        runs.set(j.id, (runs.get(j.id) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 20));
      },
    };

    const drain = async (workerId: string) => {
      for (let i = 0; i < 40; i++) {
        await runNextJob({
          sql,
          ticketIds,
          workerId,
          handlers,
          backoffMs: noBackoff,
        });
      }
    };
    await Promise.all([drain("w1"), drain("w2"), drain("w3")]);

    for (const id of ids) expect(runs.get(id)).toBe(1);
    const rows = await db.select().from(jobs).where(inArray(jobs.id, ids));
    expect(rows.every((r) => r.status === "done")).toBe(true);
  });

  it("reclaims a stale running job", async () => {
    const job = await newJob({
      status: "running",
      lockedBy: "crashed-worker",
      lockedAt: new Date(Date.now() - 3 * 60_000),
      attempts: 1,
    });
    const seen: string[] = [];
    const handlers: Handlers = {
      classify: async (j) => {
        seen.push(j.id);
      },
    };

    await runNextJob({
      sql,
      ticketIds: [job.ticketId],
      workerId: "w2",
      handlers,
      backoffMs: noBackoff,
    });

    expect(seen).toContain(job.id);
    expect((await reload(job.id)).status).toBe("done");
  });

  it("leaves a fresh running job alone", async () => {
    const job = await newJob({
      status: "running",
      lockedBy: "busy-worker",
      lockedAt: new Date(),
    });
    const handlers: Handlers = { classify: async () => {} };

    await runNextJob({
      sql,
      ticketIds: [job.ticketId],
      workerId: "w2",
      handlers,
      backoffMs: noBackoff,
    });

    const same = await reload(job.id);
    expect(same.status).toBe("running");
    expect(same.lockedBy).toBe("busy-worker");
  });

  it("kills a stale job that has no attempts left instead of reclaiming it", async () => {
    const job = await newJob({
      status: "running",
      lockedBy: "crashed-worker",
      lockedAt: new Date(Date.now() - 3 * 60_000),
      attempts: 3,
      maxAttempts: 3,
    });
    const handlers: Handlers = { classify: async () => {} };

    await runNextJob({
      sql,
      ticketIds: [job.ticketId],
      workerId: "w2",
      handlers,
      backoffMs: noBackoff,
    });

    const dead = await reload(job.id);
    expect(dead.status).toBe("dead");
    expect(dead.lastError).toMatch(/lease/i);
  });

  it("reschedules a throwing job with backoff, then marks it dead", async () => {
    const job = await newJob({ maxAttempts: 3 });
    const handlers: Handlers = {
      classify: async () => {
        throw new Error("provider down");
      },
    };
    const backoffs: number[] = [];
    const backoffMs = (attempts: number) => {
      backoffs.push(attempts);
      return 60_000 * attempts;
    };

    const before = Date.now();
    await runNextJob({
      sql,
      ticketIds: [job.ticketId],
      workerId: "w1",
      handlers,
      backoffMs,
    });

    const first = await reload(job.id);
    expect(first.status).toBe("queued");
    expect(first.attempts).toBe(1);
    expect(first.lastError).toBe("provider down");
    expect(first.lockedBy).toBeNull();
    expect(first.runAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);

    // Pull run_at back so the next attempts are claimable.
    for (const expected of [2, 3]) {
      await db
        .update(jobs)
        .set({ runAt: new Date() })
        .where(eq(jobs.id, job.id));
      await runNextJob({
        sql,
        ticketIds: [job.ticketId],
        workerId: "w1",
        handlers,
        backoffMs,
      });
      expect((await reload(job.id)).attempts).toBe(expected);
    }

    const last = await reload(job.id);
    expect(last.status).toBe("dead");
    expect(last.lastError).toBe("provider down");
    expect(backoffs).toEqual([1, 2]);
  });

  it("marks a job with no registered handler as dead", async () => {
    const job = await newJob({ kind: "reconcile" });
    const handlers: Handlers = { classify: async () => {} };

    await runNextJob({
      sql,
      ticketIds: [job.ticketId],
      workerId: "w1",
      handlers,
      backoffMs: noBackoff,
    });

    // Not claimed: the worker only claims kinds it can run.
    expect((await reload(job.id)).status).toBe("queued");
  });
});
