import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { integrationActor, systemActor, userActor } from "@/domain/actor";
import { IllegalTransitionError } from "@/domain/transitions";
import { dispatches, ticketEvents, tickets, users } from "@/infra/db/schema";
import { createTicket } from "@/services/createTicket";
import {
  appendTicketEvent,
  moveClassificationState,
  moveDispatchStatus,
  moveTicketStatus,
} from "@/services/ticketWrites";
import { connectTestDb } from "./support/db";

// The one write path for status columns and Ticket Events (SCRUM-41).

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

async function newTicket() {
  const [requester] = await db
    .insert(users)
    .values({ name: "R", email: `${randomUUID()}@t.example`, department: "QA" })
    .returning();
  const result = await createTicket(
    db,
    {
      requesterId: requester!.id,
      idempotencyKey: randomUUID(),
      title: "Printer jam",
      description: "The printer on floor 2 is jammed again.",
    },
    integrationActor,
  );
  if (result.kind !== "created") throw new Error(result.kind);
  return { ticket: result.ticket, requesterId: requester!.id };
}

async function stored(ticketId: string) {
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  const events = await db
    .select({ type: ticketEvents.type, data: ticketEvents.data })
    .from(ticketEvents)
    .where(eq(ticketEvents.ticketId, ticketId))
    .orderBy(asc(ticketEvents.id));
  return { ticket: ticket!, types: events.map((e) => e.type), events };
}

describe("moveTicketStatus", () => {
  it("sets the Ticket Status and appends status_changed in one go", async () => {
    const { ticket, requesterId } = await newTicket();

    const event = await db.transaction((tx) =>
      moveTicketStatus(tx, ticket, "resolved", userActor(requesterId)),
    );

    const after = await stored(ticket.id);
    expect(after.ticket.status).toBe("resolved");
    expect(after.events.at(-1)).toEqual({
      type: "status_changed",
      data: { from: "open", to: "resolved" },
    });
    expect(event.ticketId).toBe(ticket.id);
  });

  it("persists nothing for an illegal transition", async () => {
    const { ticket } = await newTicket();

    await expect(
      db.transaction((tx) =>
        moveTicketStatus(tx, ticket, "closed", systemActor),
      ),
    ).rejects.toThrow(IllegalTransitionError);

    const after = await stored(ticket.id);
    expect(after.ticket.status).toBe("open");
    expect(after.types).toEqual(["ticket_created"]);
  });

  it("refuses a move from a status the Ticket is no longer in", async () => {
    const { ticket } = await newTicket();
    await db.transaction((tx) =>
      moveTicketStatus(tx, ticket, "resolved", systemActor),
    );

    // `ticket` still says open: resolved → resolved must not slip through
    // as open → resolved.
    await expect(
      db.transaction((tx) =>
        moveTicketStatus(tx, ticket, "resolved", systemActor),
      ),
    ).rejects.toThrow(/no longer open/);

    expect((await stored(ticket.id)).types).toEqual([
      "ticket_created",
      "status_changed",
    ]);
  });
});

describe("moveClassificationState", () => {
  const toReview = (reason: string) =>
    ({
      actor: systemActor,
      event: { type: "sent_to_review", data: { reason } },
    }) as const;

  it("moves the state and appends the event", async () => {
    const { ticket } = await newTicket();

    await db.transaction((tx) =>
      moveClassificationState(tx, ticket, "needs_review", toReview("AI down")),
    );

    const after = await stored(ticket.id);
    expect(after.ticket.classificationState).toBe("needs_review");
    expect(after.events.at(-1)).toEqual({
      type: "sent_to_review",
      data: { reason: "AI down" },
    });
  });

  it("writes only the event when the state stays the same", async () => {
    const { ticket } = await newTicket();
    const inReview = {
      ...ticket,
      classificationState: "needs_review",
    } as const;
    await db.transaction((tx) =>
      moveClassificationState(tx, ticket, "needs_review", toReview("first")),
    );

    await db.transaction((tx) =>
      moveClassificationState(tx, inReview, "needs_review", toReview("again")),
    );

    expect((await stored(ticket.id)).types).toEqual([
      "ticket_created",
      "sent_to_review",
      "sent_to_review",
    ]);
  });

  it("persists nothing for an illegal transition", async () => {
    const { ticket } = await newTicket();
    const inReview = {
      ...ticket,
      classificationState: "needs_review",
    } as const;
    await db.transaction((tx) =>
      moveClassificationState(tx, ticket, "needs_review", toReview("x")),
    );

    await expect(
      db.transaction((tx) =>
        moveClassificationState(tx, inReview, "pending", toReview("y")),
      ),
    ).rejects.toThrow(IllegalTransitionError);

    const after = await stored(ticket.id);
    expect(after.ticket.classificationState).toBe("needs_review");
    expect(after.types).toEqual(["ticket_created", "sent_to_review"]);
  });
});

describe("moveDispatchStatus", () => {
  async function newDispatch() {
    const { ticket } = await newTicket();
    const [dispatch] = await db
      .insert(dispatches)
      .values({
        ticketId: ticket.id,
        sequence: 1,
        category: "access",
        priority: "normal",
        team: "identity_access",
        route: "standard",
      })
      .returning();
    return dispatch!;
  }

  async function storedDispatch(id: string) {
    const [row] = await db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, id));
    return row!;
  }

  it("moves the status, sets other columns and appends the event", async () => {
    const dispatch = await newDispatch();
    const deadline = new Date("2030-01-01T00:00:00Z");

    await db.transaction((tx) =>
      moveDispatchStatus(tx, dispatch, "sent", {
        set: { autoAttempts: 1, callbackDeadline: deadline },
      }),
    );
    await db.transaction((tx) =>
      moveDispatchStatus(tx, { ...dispatch, status: "sent" }, "unknown", {
        actor: systemActor,
        event: { type: "dispatch_unknown", data: { dispatchId: dispatch.id } },
      }),
    );

    const after = await storedDispatch(dispatch.id);
    expect(after).toMatchObject({
      status: "unknown",
      autoAttempts: 1,
      callbackDeadline: deadline,
    });
    expect((await stored(dispatch.ticketId)).types).toEqual([
      "ticket_created",
      "dispatch_unknown",
    ]);
  });

  it("persists nothing for an illegal transition", async () => {
    const dispatch = await newDispatch();

    await expect(
      db.transaction((tx) =>
        moveDispatchStatus(tx, dispatch, "succeeded", {
          actor: systemActor,
          event: {
            type: "dispatch_succeeded",
            data: { dispatchId: dispatch.id, reconciled: true },
          },
        }),
      ),
    ).rejects.toThrow(IllegalTransitionError);

    expect((await storedDispatch(dispatch.id)).status).toBe("pending");
    expect((await stored(dispatch.ticketId)).types).toEqual(["ticket_created"]);
  });
});

describe("appendTicketEvent", () => {
  it("appends an event attributed to its actor", async () => {
    const { ticket, requesterId } = await newTicket();

    await db.transaction((tx) =>
      appendTicketEvent(tx, ticket.id, userActor(requesterId), {
        type: "ticket_taken",
        data: { assigneeId: requesterId },
      }),
    );

    const [event] = await db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, ticket.id))
      .orderBy(desc(ticketEvents.id))
      .limit(1);
    expect(event).toMatchObject({
      type: "ticket_taken",
      actor: "user",
      actorUserId: requesterId,
    });
  });
});
