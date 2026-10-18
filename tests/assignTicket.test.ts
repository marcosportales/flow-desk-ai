import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { integrationActor, userActor } from "@/domain/actor";
import type { Team } from "@/domain/routing";
import {
  teamMemberships,
  ticketEvents,
  tickets,
  users,
} from "@/infra/db/schema";
import {
  reassignTicket,
  releaseTicket,
  takeTicket,
} from "@/services/assignTicket";
import { createTicket } from "@/services/createTicket";
import { connectTestDb } from "./support/db";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

async function newUser(teams: Team[] = []) {
  const [user] = await db
    .insert(users)
    .values({ name: "U", email: `${randomUUID()}@t.example`, department: "QA" })
    .returning();
  for (const team of teams) {
    await db.insert(teamMemberships).values({ userId: user!.id, team });
  }
  return user!.id;
}

// A Ticket in Manual Review (no Category), which belongs to service_desk.
async function newTicket() {
  const result = await createTicket(
    db,
    {
      requesterId: await newUser(),
      idempotencyKey: randomUUID(),
      title: "Take me",
      description: "Somebody on the desk should pick this up.",
    },
    integrationActor,
  );
  if (result.kind !== "created") throw new Error("not created");
  return result.ticket.id;
}

async function assigneeOf(ticketId: string) {
  const [row] = await db
    .select({ assigneeId: tickets.assigneeId })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  return row!.assigneeId;
}

async function assignmentEvents(ticketId: string) {
  const rows = await db
    .select()
    .from(ticketEvents)
    .where(eq(ticketEvents.ticketId, ticketId))
    .orderBy(ticketEvents.id);
  return rows.filter((e) =>
    ["ticket_taken", "ticket_released", "ticket_reassigned"].includes(e.type),
  );
}

describe("takeTicket", () => {
  it("assigns a Ticket with no Assignee to the taker and records who took it", async () => {
    const ticket = await newTicket();
    const operator = await newUser(["service_desk"]);

    expect(await takeTicket(db, ticket, userActor(operator))).toEqual({
      kind: "ok",
    });

    expect(await assigneeOf(ticket)).toBe(operator);
    const [event] = await assignmentEvents(ticket);
    expect(event).toMatchObject({
      type: "ticket_taken",
      actor: "user",
      actorUserId: operator,
      data: { assigneeId: operator },
    });
  });

  it("refuses a Ticket that already has an Assignee", async () => {
    const ticket = await newTicket();
    const first = await newUser(["service_desk"]);
    const second = await newUser(["service_desk"]);
    await takeTicket(db, ticket, userActor(first));

    const result = await takeTicket(db, ticket, userActor(second));

    expect(result.kind).toBe("already_assigned");
    expect(await assigneeOf(ticket)).toBe(first);
    expect(await assignmentEvents(ticket)).toHaveLength(1);
  });

  it("reports an unknown Ticket", async () => {
    const operator = await newUser(["service_desk"]);
    expect(await takeTicket(db, randomUUID(), userActor(operator))).toEqual({
      kind: "not_found",
    });
  });

  it("yields exactly one Assignee when Operators take at the same time", async () => {
    const ticket = await newTicket();
    const operators = await Promise.all(
      Array.from({ length: 5 }, () => newUser(["service_desk"])),
    );
    // One connection each, so the takes really overlap in Postgres.
    const clients = operators.map(() => connectTestDb());
    try {
      const results = await Promise.all(
        operators.map((id, i) =>
          takeTicket(clients[i]!.db, ticket, userActor(id)),
        ),
      );

      expect(results.filter((r) => r.kind === "ok")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "already_assigned")).toHaveLength(
        operators.length - 1,
      );
      const winner = operators[results.findIndex((r) => r.kind === "ok")];
      expect(await assigneeOf(ticket)).toBe(winner);
      expect(await assignmentEvents(ticket)).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((c) => c.sql.end()));
    }
  });
});

describe("releaseTicket", () => {
  it("clears the Assignee and records the release", async () => {
    const ticket = await newTicket();
    const operator = await newUser(["service_desk"]);
    await takeTicket(db, ticket, userActor(operator));

    expect(await releaseTicket(db, ticket, userActor(operator))).toEqual({
      kind: "ok",
    });

    expect(await assigneeOf(ticket)).toBeNull();
    const events = await assignmentEvents(ticket);
    expect(events.at(-1)).toMatchObject({
      type: "ticket_released",
      actorUserId: operator,
      data: { from: operator },
    });
  });

  it("lets another Operator of the Team release it (ADR 0008)", async () => {
    const ticket = await newTicket();
    const owner = await newUser(["service_desk"]);
    const cover = await newUser(["service_desk"]);
    await takeTicket(db, ticket, userActor(owner));

    expect((await releaseTicket(db, ticket, userActor(cover))).kind).toBe("ok");
    expect(await assigneeOf(ticket)).toBeNull();
  });

  it("refuses a Ticket with no Assignee", async () => {
    const ticket = await newTicket();
    const operator = await newUser(["service_desk"]);
    expect((await releaseTicket(db, ticket, userActor(operator))).kind).toBe(
      "illegal_state",
    );
  });
});

describe("reassignTicket", () => {
  it("hands the Ticket to another member of the Team", async () => {
    const ticket = await newTicket();
    const owner = await newUser(["service_desk"]);
    const colleague = await newUser(["service_desk", "data_team"]);
    await takeTicket(db, ticket, userActor(owner));

    const result = await reassignTicket(
      db,
      ticket,
      { assigneeId: colleague },
      userActor(owner),
    );

    expect(result).toEqual({ kind: "ok" });
    expect(await assigneeOf(ticket)).toBe(colleague);
    expect((await assignmentEvents(ticket)).at(-1)).toMatchObject({
      type: "ticket_reassigned",
      actorUserId: owner,
      data: { from: owner, to: colleague },
    });
  });

  it("can assign a Ticket with no Assignee", async () => {
    const ticket = await newTicket();
    const operator = await newUser(["service_desk"]);
    const colleague = await newUser(["service_desk"]);

    const result = await reassignTicket(
      db,
      ticket,
      { assigneeId: colleague },
      userActor(operator),
    );

    expect(result.kind).toBe("ok");
    expect(await assigneeOf(ticket)).toBe(colleague);
  });

  it("refuses a User outside the Ticket's Team", async () => {
    const ticket = await newTicket();
    const owner = await newUser(["service_desk"]);
    const outsider = await newUser(["data_team"]);
    await takeTicket(db, ticket, userActor(owner));

    const result = await reassignTicket(
      db,
      ticket,
      { assigneeId: outsider },
      userActor(owner),
    );

    expect(result.kind).toBe("invalid");
    expect(await assigneeOf(ticket)).toBe(owner);
    expect(await assignmentEvents(ticket)).toHaveLength(1);
  });

  it("refuses a User who does not exist and a malformed id", async () => {
    const ticket = await newTicket();
    const operator = await newUser(["service_desk"]);
    for (const assigneeId of [randomUUID(), "nope", ""]) {
      const result = await reassignTicket(
        db,
        ticket,
        { assigneeId },
        userActor(operator),
      );
      expect(result.kind).toBe("invalid");
    }
    expect(await assigneeOf(ticket)).toBeNull();
  });

  it("refuses handing the Ticket to its current Assignee", async () => {
    const ticket = await newTicket();
    const owner = await newUser(["service_desk"]);
    await takeTicket(db, ticket, userActor(owner));
    const result = await reassignTicket(
      db,
      ticket,
      { assigneeId: owner },
      userActor(owner),
    );
    expect(result.kind).toBe("already_assigned");
  });
});
