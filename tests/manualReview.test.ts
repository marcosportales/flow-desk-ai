import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { FakeClassifier } from "@/infra/classifier/fake";
import {
  dispatches,
  jobs,
  users,
  ticketEvents,
  tickets,
} from "@/infra/db/schema";
import { changeTicketStatus } from "@/services/changeTicketStatus";
import { classifyManually } from "@/services/classifyManually";
import { classifyTicket } from "@/services/classifyTicket";
import { createTicket } from "@/services/createTicket";
import { overridePriority } from "@/services/overridePriority";
import { rerunClassification } from "@/services/rerunClassification";
import { retryDispatch } from "@/services/retryDispatch";
import { connectTestDb } from "./support/db";
import { dispatchFixtures } from "./support/dispatchFixtures";

const { sql, db } = connectTestDb();
const { classifiedTicket } = dispatchFixtures(db, sql);
afterAll(() => sql.end());

const dispatchesOf = (ticketId: string) =>
  db
    .select()
    .from(dispatches)
    .where(eq(dispatches.ticketId, ticketId))
    .orderBy(asc(dispatches.sequence));
const eventsOf = (ticketId: string) =>
  db
    .select()
    .from(ticketEvents)
    .where(eq(ticketEvents.ticketId, ticketId))
    .orderBy(asc(ticketEvents.id));
const ticketOf = async (id: string) =>
  (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

async function newTicket(title: string) {
  const [requester] = await db
    .insert(users)
    .values({ name: "R", email: `${randomUUID()}@t.example`, department: "QA" })
    .returning();
  const result = await createTicket(db, {
    requesterId: requester!.id,
    idempotencyKey: randomUUID(),
    title,
    description: "A request the model cannot make sense of at all.",
  });
  if (result.kind !== "created") throw new Error("not created");
  return result.ticket;
}

// A Ticket the AI sent to Manual Review (invalid output, one repair).
async function needsReviewTicket() {
  const created = await newTicket("Something odd");
  await classifyTicket(db, new FakeClassifier("invalid"), {
    ticketId: created.id,
    attempts: 3,
    maxAttempts: 3,
  });
  await db
    .update(jobs)
    .set({ status: "done" })
    .where(eq(jobs.ticketId, created.id));
  return ticketOf(created.id);
}

const facts = {
  category: "access",
  summary: "Cannot log in to the VPN",
  blocks_work: true,
  impact_scope: "team",
  reason: "Agent read the request and confirmed with the requester",
} as const;

describe("classifyManually", () => {
  it("classifies a needs_review Ticket, applies the rules and creates a Dispatch", async () => {
    const ticket = await needsReviewTicket();
    expect(ticket.classificationState).toBe("needs_review");

    const result = await classifyManually(db, ticket.id, facts);

    expect(result.kind).toBe("ok");
    expect(await ticketOf(ticket.id)).toMatchObject({
      classificationState: "classified",
      classificationSource: "human",
      category: "access",
      priority: "high",
      priorityRule: "team_blocker",
      team: "identity_access",
    });
    const [dispatch] = await dispatchesOf(ticket.id);
    expect(dispatch).toMatchObject({
      status: "pending",
      team: "identity_access",
      route: "standard",
    });
    const queued = await db
      .select()
      .from(jobs)
      .where(eq(jobs.dispatchId, dispatch!.id));
    expect(queued.map((j) => j.status)).toEqual(["queued"]);
    const types = (await eventsOf(ticket.id)).map((e) => [e.type, e.actor]);
    expect(types).toContainEqual(["classified", "human"]);
    expect(types).toContainEqual(["priority_computed", "system"]);
    expect(types).toContainEqual(["dispatch_created", "system"]);
  });

  it("keeps a non-dispatchable Category in review without a Dispatch", async () => {
    const ticket = await needsReviewTicket();

    const result = await classifyManually(db, ticket.id, {
      ...facts,
      category: "inquiry",
      blocks_work: false,
    });

    expect(result.kind).toBe("ok");
    expect(await ticketOf(ticket.id)).toMatchObject({
      classificationState: "needs_review",
      category: "inquiry",
      classificationSource: "human",
    });
    expect(await dispatchesOf(ticket.id)).toHaveLength(0);
  });

  it("supersedes the active Dispatch when the correction changes the Team", async () => {
    const ticket = await classifiedTicket(); // ERP blocker → urgent, it_systems
    const [first] = await dispatchesOf(ticket.id);

    const result = await classifyManually(db, ticket.id, {
      ...facts,
      category: "data",
      blocks_work: false,
      impact_scope: "individual",
    });

    expect(result.kind).toBe("ok");
    const all = await dispatchesOf(ticket.id);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ id: first!.id, status: "failed" });
    expect(all[0]!.supersededBy).toBe(all[1]!.id);
    expect(all[1]).toMatchObject({
      status: "pending",
      team: "data_team",
      route: "standard",
      sequence: 2,
    });
    expect(
      (await eventsOf(ticket.id)).find((e) => e.type === "dispatch_superseded"),
    ).toMatchObject({ data: { dispatchId: first!.id } });
  });

  it("creates no new Dispatch when the Team and route are unchanged", async () => {
    const ticket = await classifiedTicket();

    await classifyManually(db, ticket.id, {
      ...facts,
      category: "erp",
      summary: "SAP down, corrected summary",
      impact_scope: "individual",
    });

    expect(await dispatchesOf(ticket.id)).toHaveLength(1);
    expect((await ticketOf(ticket.id)).summary).toBe(
      "SAP down, corrected summary",
    );
  });

  it("rejects invalid facts and unknown Tickets", async () => {
    const ticket = await needsReviewTicket();
    expect(
      await classifyManually(db, ticket.id, { ...facts, category: "bogus" }),
    ).toMatchObject({ kind: "invalid" });
    expect(await classifyManually(db, randomUUID(), facts)).toEqual({
      kind: "not_found",
    });
  });

  it("rejects a pending Ticket", async () => {
    const created = await newTicket("Fresh one");
    expect(await classifyManually(db, created.id, facts)).toMatchObject({
      kind: "illegal_state",
    });
  });
});

describe("overridePriority", () => {
  it("rejects an override without a reason", async () => {
    const ticket = await classifiedTicket();
    for (const reason of [undefined, "", "   "]) {
      expect(
        await overridePriority(db, ticket.id, { priority: "low", reason }),
      ).toMatchObject({ kind: "invalid" });
    }
    expect((await ticketOf(ticket.id)).priority).toBe("urgent");
  });

  it("overrides, keeps the computed Priority and creates a new Dispatch when the route changes", async () => {
    const ticket = await classifiedTicket(); // urgent route

    const result = await overridePriority(db, ticket.id, {
      priority: "normal",
      reason: "Requester has a workaround",
    });

    expect(result.kind).toBe("ok");
    expect(await ticketOf(ticket.id)).toMatchObject({
      priority: "normal",
      computedPriority: "urgent",
      priorityOverrideReason: "Requester has a workaround",
    });
    const all = await dispatchesOf(ticket.id);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ priority: "normal", route: "standard" });
    expect(all[0]!.supersededBy).toBe(all[1]!.id);
    expect(
      (await eventsOf(ticket.id)).find((e) => e.type === "priority_overridden"),
    ).toMatchObject({
      actor: "human",
      data: {
        from: "urgent",
        to: "normal",
        reason: "Requester has a workaround",
      },
    });
  });

  it("creates no Dispatch when the route stays the same", async () => {
    const ticket = await classifiedTicket();
    await overridePriority(db, ticket.id, { priority: "high", reason: "a" });
    expect(await dispatchesOf(ticket.id)).toHaveLength(2); // urgent → standard

    await overridePriority(db, ticket.id, { priority: "low", reason: "b" });

    expect(await dispatchesOf(ticket.id)).toHaveLength(2); // standard → standard
  });

  it("clears the override when set back to the computed Priority", async () => {
    const ticket = await classifiedTicket();
    await overridePriority(db, ticket.id, { priority: "low", reason: "x" });

    await overridePriority(db, ticket.id, {
      priority: "urgent",
      reason: "Back to normal",
    });

    expect(await ticketOf(ticket.id)).toMatchObject({
      priority: "urgent",
      priorityOverrideReason: null,
    });
  });

  it("only applies to a classified Ticket", async () => {
    const ticket = await needsReviewTicket();
    expect(
      await overridePriority(db, ticket.id, { priority: "low", reason: "x" }),
    ).toMatchObject({ kind: "illegal_state" });
  });
});

describe("changeTicketStatus", () => {
  it("moves open → resolved and records the event, without a Dispatch", async () => {
    const ticket = await needsReviewTicket();

    const result = await changeTicketStatus(db, ticket.id, {
      status: "resolved",
    });

    expect(result.kind).toBe("ok");
    expect((await ticketOf(ticket.id)).status).toBe("resolved");
    expect(await dispatchesOf(ticket.id)).toHaveLength(0);
    expect((await eventsOf(ticket.id)).at(-1)).toMatchObject({
      type: "status_changed",
      actor: "human",
      data: { from: "open", to: "resolved" },
    });
  });

  it("rejects an illegal transition", async () => {
    const ticket = await needsReviewTicket();
    const result = await changeTicketStatus(db, ticket.id, {
      status: "closed",
    });
    expect(result).toMatchObject({ kind: "illegal_transition" });
    expect((await ticketOf(ticket.id)).status).toBe("open");
  });

  it("rejects an unknown status", async () => {
    const ticket = await needsReviewTicket();
    expect(
      await changeTicketStatus(db, ticket.id, { status: "bogus" }),
    ).toMatchObject({ kind: "invalid" });
  });
});

describe("rerunClassification", () => {
  it("queues one classify job for a needs_review Ticket", async () => {
    const ticket = await needsReviewTicket();

    expect(await rerunClassification(db, ticket.id)).toEqual({
      kind: "queued",
    });
    expect(await rerunClassification(db, ticket.id)).toEqual({
      kind: "already_queued",
    });

    const rows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.ticketId, ticket.id));
    expect(rows.filter((j) => j.status === "queued")).toHaveLength(1);
    expect((await eventsOf(ticket.id)).at(-1)).toMatchObject({
      type: "classification_rerun_requested",
      actor: "human",
    });
  });

  it("is refused unless the Ticket needs review", async () => {
    const ticket = await classifiedTicket();
    expect(await rerunClassification(db, ticket.id)).toMatchObject({
      kind: "not_rerunnable",
    });
  });
});

describe("retryDispatch on a superseded Dispatch", () => {
  it("is refused", async () => {
    const ticket = await classifiedTicket();
    const [first] = await dispatchesOf(ticket.id);
    await overridePriority(db, ticket.id, { priority: "low", reason: "x" });

    expect(await retryDispatch(db, first!.id)).toMatchObject({
      kind: "not_retryable",
    });
  });
});
