import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createTicket } from "@/services/createTicket";
import { classifyTicket } from "@/services/classifyTicket";
import { FakeClassifier } from "@/infra/classifier/fake";
import {
  type Classifier,
  ClassifierProviderError,
} from "@/infra/classifier/types";
import {
  classificationAttempts,
  dispatches,
  jobs,
  users,
  ticketEvents,
  tickets,
} from "@/infra/db/schema";
import { runNextJob } from "@/worker/runner";
import { connectTestDb } from "./support/db";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

const ERP_BLOCKER =
  "I haven't been able to access SAP since this morning, and I need to process some invoices.";

// Each test gets its own Ticket (created the way production does, with its
// classify job), so test files sharing the database never see each other.
async function newTicket(description: string) {
  const [requester] = await db
    .insert(users)
    .values({
      name: "Classify Test",
      email: `${randomUUID()}@test.example`,
      department: "QA",
    })
    .returning();
  const result = await createTicket(db, {
    requesterId: requester!.id,
    idempotencyKey: randomUUID(),
    title: "A request",
    description,
  });
  if (result.kind !== "created") throw new Error("ticket not created");
  return result.ticket;
}

const job = (ticketId: string, attempts = 1, maxAttempts = 3) => ({
  id: randomUUID(),
  kind: "classify" as const,
  ticketId,
  dispatchId: null,
  attempts,
  maxAttempts,
});

async function snapshot(ticketId: string) {
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  return {
    ticket: ticket!,
    attempts: await db
      .select()
      .from(classificationAttempts)
      .where(eq(classificationAttempts.ticketId, ticketId))
      .orderBy(asc(classificationAttempts.attemptNo)),
    dispatches: await db
      .select()
      .from(dispatches)
      .where(eq(dispatches.ticketId, ticketId)),
    jobs: await db.select().from(jobs).where(eq(jobs.ticketId, ticketId)),
    events: await db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, ticketId))
      .orderBy(asc(ticketEvents.id)),
  };
}

// Answers from a script, one entry per call; a string is raw model output.
function scripted(...answers: Array<string | Error>): Classifier {
  return {
    provider: "scripted",
    model: "scripted-1",
    async classify() {
      const next = answers.shift();
      if (next === undefined) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return { rawOutput: next };
    },
  };
}

const validJson = JSON.stringify({
  category: "data",
  summary: "Wrong numbers in a report",
  blocks_work: false,
  impact_scope: "team",
  reason: "Report data is wrong.",
});

describe("classifyTicket", () => {
  it("Scenario B: an ERP blocker is urgent, with the rule recorded and a Dispatch queued", async () => {
    const created = await newTicket(ERP_BLOCKER);

    await classifyTicket(db, new FakeClassifier("valid"), job(created.id));

    const s = await snapshot(created.id);
    expect(s.ticket).toMatchObject({
      classificationState: "classified",
      category: "erp",
      blocksWork: true,
      impactScope: "individual",
      classificationSource: "ai",
      priority: "urgent",
      computedPriority: "urgent",
      priorityRule: "erp_blocker",
      team: "it_systems",
    });
    expect(s.attempts).toHaveLength(1);
    expect(s.attempts[0]).toMatchObject({
      kind: "initial",
      outcome: "valid",
      provider: "fake",
    });
    expect(s.dispatches).toHaveLength(1);
    expect(s.dispatches[0]).toMatchObject({
      status: "pending",
      route: "urgent",
      priority: "urgent",
      team: "it_systems",
      category: "erp",
    });
    expect(
      s.jobs.filter(
        (j) => j.kind === "dispatch" && j.dispatchId === s.dispatches[0]!.id,
      ),
    ).toHaveLength(1);
    expect(s.events.map((e) => e.type)).toEqual([
      "ticket_created",
      "classification_attempted",
      "classified",
      "priority_computed",
      "dispatch_created",
    ]);
    const priorityEvent = s.events.find((e) => e.type === "priority_computed")!;
    expect(priorityEvent.data).toMatchObject({
      priority: "urgent",
      rule: "erp_blocker",
    });
    expect(
      (priorityEvent.data as { evaluated: unknown[] }).evaluated,
    ).toHaveLength(5);
  });

  it("sends a non-dispatchable Category to manual review with no Dispatch", async () => {
    const created = await newTicket(
      "I need an update on the status of a previous request.",
    );

    await classifyTicket(db, new FakeClassifier("valid"), job(created.id));

    const s = await snapshot(created.id);
    expect(s.ticket).toMatchObject({
      classificationState: "needs_review",
      category: "inquiry",
      team: "service_desk",
    });
    expect(s.dispatches).toHaveLength(0);
    expect(s.jobs.filter((j) => j.kind === "dispatch")).toHaveLength(0);
    expect(s.events.map((e) => e.type)).toContain("sent_to_review");
  });

  it("Scenario D: invalid output, a repair, still invalid → needs_review, no Dispatch, raw output kept", async () => {
    const created = await newTicket(ERP_BLOCKER);

    await classifyTicket(db, new FakeClassifier("invalid"), job(created.id));

    const s = await snapshot(created.id);
    expect(s.ticket.classificationState).toBe("needs_review");
    expect(s.ticket.category).toBeNull();
    expect(s.ticket.description).toBe(ERP_BLOCKER);
    expect(s.attempts.map((a) => [a.kind, a.outcome])).toEqual([
      ["initial", "invalid_output"],
      ["repair", "invalid_output"],
    ]);
    expect(s.attempts[0]!.rawOutput).toContain("not-a-category");
    expect(s.attempts[0]!.error).toBeTruthy();
    expect(s.dispatches).toHaveLength(0);
    expect(s.jobs.filter((j) => j.kind === "dispatch")).toHaveLength(0);
    expect(s.events.map((e) => e.type)).toEqual([
      "ticket_created",
      "classification_attempted",
      "classification_attempted",
      "sent_to_review",
    ]);
  });

  it("accepts a valid answer to the repair call", async () => {
    const created = await newTicket(ERP_BLOCKER);

    await classifyTicket(
      db,
      scripted("not json at all", validJson),
      job(created.id),
    );

    const s = await snapshot(created.id);
    expect(s.ticket).toMatchObject({
      classificationState: "classified",
      category: "data",
      priority: "low",
      priorityRule: "default",
    });
    expect(s.attempts.map((a) => [a.kind, a.outcome])).toEqual([
      ["initial", "invalid_output"],
      ["repair", "valid"],
    ]);
  });

  it("reads JSON wrapped in a code fence", async () => {
    const created = await newTicket(ERP_BLOCKER);

    await classifyTicket(
      db,
      scripted("```json\n" + validJson + "\n```"),
      job(created.id),
    );

    expect((await snapshot(created.id)).ticket.category).toBe("data");
  });

  it("rejects output with unexpected keys", async () => {
    const created = await newTicket(ERP_BLOCKER);
    const extra = JSON.stringify({
      ...JSON.parse(validJson),
      priority: "urgent",
    });

    await classifyTicket(db, scripted(extra, extra), job(created.id));

    expect((await snapshot(created.id)).ticket.classificationState).toBe(
      "needs_review",
    );
  });

  it("Scenario D: a provider error throws for retry while attempts remain, and is recorded", async () => {
    const created = await newTicket(ERP_BLOCKER);

    await expect(
      classifyTicket(
        db,
        new FakeClassifier("provider_error"),
        job(created.id, 1),
      ),
    ).rejects.toBeInstanceOf(ClassifierProviderError);

    const s = await snapshot(created.id);
    expect(s.ticket.classificationState).toBe("pending");
    expect(s.attempts.map((a) => a.outcome)).toEqual(["provider_error"]);
    expect(s.attempts[0]!.error).toContain("provider error");
    expect(s.dispatches).toHaveLength(0);
  });

  it("Scenario D: provider_error ×3 through the worker → needs_review, no Dispatch", async () => {
    const created = await newTicket(ERP_BLOCKER);
    const classifier = new FakeClassifier("provider_error");

    for (let i = 0; i < 3; i++) {
      const ran = await runNextJob({
        sql,
        workerId: "classify-test",
        ticketIds: [created.id],
        backoffMs: () => 0,
        handlers: {
          classify: (j) => classifyTicket(db, classifier, j),
        },
      });
      expect(ran).toBe(true);
    }

    const s = await snapshot(created.id);
    expect(s.ticket.classificationState).toBe("needs_review");
    expect(s.attempts.map((a) => a.outcome)).toEqual([
      "provider_error",
      "provider_error",
      "provider_error",
    ]);
    expect(s.dispatches).toHaveLength(0);
    expect(s.jobs.filter((j) => j.kind === "classify")[0]!.status).toBe("done");
    expect(s.events.at(-1)).toMatchObject({ type: "sent_to_review" });
  });

  it("leaves a Ticket alone when another worker classified it during a failing provider call", async () => {
    const created = await newTicket(ERP_BLOCKER);
    const racing: Classifier = {
      provider: "racing",
      model: "racing-1",
      async classify() {
        await classifyTicket(db, new FakeClassifier("valid"), job(created.id));
        throw new ClassifierProviderError("too late");
      },
    };

    await classifyTicket(db, racing, job(created.id, 3, 3));

    const s = await snapshot(created.id);
    expect(s.ticket.classificationState).toBe("classified");
    expect(s.dispatches).toHaveLength(1);
    expect(s.events.map((e) => e.type)).not.toContain("sent_to_review");
  });

  it("does nothing for a Ticket that is already classified", async () => {
    const created = await newTicket(ERP_BLOCKER);
    await classifyTicket(db, new FakeClassifier("valid"), job(created.id));

    await classifyTicket(
      db,
      scripted(new Error("must not be called")),
      job(created.id),
    );

    const s = await snapshot(created.id);
    expect(s.attempts).toHaveLength(1);
    expect(s.dispatches).toHaveLength(1);
  });
});
