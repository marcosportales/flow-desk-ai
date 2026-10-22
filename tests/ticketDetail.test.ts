import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classificationAttempts,
  dispatchAttempts,
  dispatches,
  users,
  ticketEvents,
  tickets,
} from "@/infra/db/schema";
import type { PriorityEvaluation } from "@/domain/priority";
import { getTicketDetail } from "@/services/getTicketDetail";
import { connectTestDb } from "./support/db";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

let requesterId: string;

beforeAll(async () => {
  const [requester] = await db
    .insert(users)
    .values({
      name: "Detail Person",
      email: `${randomUUID()}@test.example`,
      department: "QA",
    })
    .returning();
  requesterId = requester!.id;
});

async function insertTicket(values: Partial<typeof tickets.$inferInsert> = {}) {
  const [row] = await db
    .insert(tickets)
    .values({
      requesterId,
      title: "Detail ticket",
      description: "A description that is long enough.",
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
      ...values,
    })
    .returning();
  return row!;
}

describe("getTicketDetail", () => {
  it("is not_found for an unknown Ticket", async () => {
    expect(await getTicketDetail(db, randomUUID())).toEqual({
      kind: "not_found",
    });
  });

  it("is not_found for another User's Ticket, found for the Requester", async () => {
    const t = await insertTicket();
    expect(
      await getTicketDetail(db, t.id, { id: randomUUID(), teams: [] }),
    ).toEqual({ kind: "not_found" });
    const own = await getTicketDetail(db, t.id, { id: requesterId, teams: [] });
    expect(own.kind).toBe("ok");
  });

  it("returns a bare pending Ticket without internals", async () => {
    const t = await insertTicket();
    const result = await getTicketDetail(db, t.id);
    if (result.kind !== "ok") throw new Error("expected ok");
    const d = result.detail;
    expect(d.ticket.id).toBe(t.id);
    expect(d.ticket).not.toHaveProperty("requestHash");
    expect(d.ticket).not.toHaveProperty("idempotencyKey");
    expect(d.requester.name).toBe("Detail Person");
    expect(d.ticket.externalReference).toBeNull();
    expect(d.classificationAttempts).toEqual([]);
    expect(d.dispatches).toEqual([]);
    expect(d.priorityEvaluation).toBeNull();
    expect(d.reason).toBeNull();
    // A Ticket awaiting classification is still in motion.
    expect(d.settled).toBe(false);
  });

  it("assembles attempts, Dispatches with attempts, events, rule table and reason", async () => {
    const t = await insertTicket({
      classificationState: "classified",
      classificationSource: "ai",
      category: "erp",
      summary: "s",
      blocksWork: true,
      impactScope: "team",
      priority: "urgent",
      computedPriority: "urgent",
      priorityRule: "erp_blocker",
      team: "it_systems",
    });
    await db.insert(classificationAttempts).values([
      {
        ticketId: t.id,
        attemptNo: 1,
        kind: "initial",
        outcome: "invalid_output",
        provider: "fake",
        model: "fake",
        rawOutput: "not json",
        error: "bad",
      },
      {
        ticketId: t.id,
        attemptNo: 2,
        kind: "repair",
        outcome: "valid",
        provider: "fake",
        model: "fake",
        parsed: { category: "erp" },
      },
    ]);
    const evaluation: PriorityEvaluation = {
      priority: "urgent",
      rule: "erp_blocker",
      evaluated: [
        { rule: "org_wide_blocker", priority: "urgent", matched: false },
        { rule: "erp_blocker", priority: "urgent", matched: true },
      ],
    };
    await db.insert(ticketEvents).values([
      { ticketId: t.id, type: "ticket_created", actor: "system", data: {} },
      {
        ticketId: t.id,
        type: "classified",
        actor: "ai",
        data: { category: "erp", reason: "ERP is down" },
      },
      {
        ticketId: t.id,
        type: "priority_computed",
        actor: "system",
        data: evaluation,
      },
    ]);
    const [d1] = await db
      .insert(dispatches)
      .values({
        ticketId: t.id,
        sequence: 1,
        category: "erp",
        priority: "urgent",
        team: "it_systems",
        route: "urgent",
        status: "failed",
      })
      .returning();
    const [d2] = await db
      .insert(dispatches)
      .values({
        ticketId: t.id,
        sequence: 2,
        category: "erp",
        priority: "urgent",
        team: "it_systems",
        route: "urgent",
        status: "sent",
      })
      .returning();
    await db.insert(dispatchAttempts).values([
      {
        dispatchId: d1!.id,
        attemptNo: 2,
        trigger: "auto",
        outcome: "failed",
        httpStatus: 500,
        error: "boom",
      },
      {
        dispatchId: d1!.id,
        attemptNo: 1,
        trigger: "auto",
        outcome: "failed",
        httpStatus: 503,
      },
      {
        dispatchId: d2!.id,
        attemptNo: 1,
        trigger: "manual",
        workflowEngine: "power_automate",
        outcome: "sent",
        httpStatus: 202,
        executionReference: "exec-9",
      },
    ]);

    const result = await getTicketDetail(db, t.id);
    if (result.kind !== "ok") throw new Error("expected ok");
    const d = result.detail;
    expect(d.classificationAttempts.map((a) => a.attemptNo)).toEqual([1, 2]);
    expect(d.classificationAttempts[0]!.rawOutput).toBe("not json");
    expect(d.dispatches.map((x) => x.sequence)).toEqual([1, 2]);
    expect(d.dispatches[0]!.attempts.map((a) => a.attemptNo)).toEqual([1, 2]);
    expect(d.dispatches[1]!.attempts[0]).toMatchObject({
      workflowEngine: "power_automate",
      executionReference: "exec-9",
    });
    expect(d.events.map((e) => e.type)).toEqual([
      "ticket_created",
      "classified",
      "priority_computed",
    ]);
    expect(d.priorityEvaluation).toEqual(evaluation);
    expect(d.reason).toBe("ERP is down");
    expect(d.settled).toBe(false); // second Dispatch is still `sent`
  });

  it("names the actor of each Ticket Event for the timeline", async () => {
    const [operator] = await db
      .insert(users)
      .values({
        name: "Olivia Operator",
        email: `${randomUUID()}@test.example`,
        department: "IT",
      })
      .returning();
    const t = await insertTicket();
    await db.insert(ticketEvents).values([
      {
        ticketId: t.id,
        type: "ticket_created",
        actor: "integration",
        data: {},
      },
      { ticketId: t.id, type: "classified", actor: "system", data: {} },
      {
        ticketId: t.id,
        type: "status_changed",
        actor: "user",
        actorUserId: operator!.id,
        data: {},
      },
      // Written before events named their actor.
      { ticketId: t.id, type: "classified", actor: "human", data: {} },
    ]);

    const result = await getTicketDetail(db, t.id);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.detail.events.map((e) => e.actorLabel)).toEqual([
      "Integration",
      "System",
      "Olivia Operator",
      "A person",
    ]);
  });

  it("is settled once classified and the latest Dispatch is terminal", async () => {
    const t = await insertTicket({ classificationState: "needs_review" });
    await db.insert(dispatches).values({
      ticketId: t.id,
      sequence: 1,
      category: "erp",
      priority: "low",
      team: "it_systems",
      route: "standard",
      status: "succeeded",
    });
    const result = await getTicketDetail(db, t.id);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.detail.settled).toBe(true);
  });
});
