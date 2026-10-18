import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { integrationActor, userActor } from "@/domain/actor";
import type { Team } from "@/domain/routing";
import { teamMemberships, users } from "@/infra/db/schema";
import {
  reassignTicket,
  releaseTicket,
  takeTicket,
} from "@/services/assignTicket";
import { FakeClassifier } from "@/infra/classifier/fake";
import { changeTicketStatus } from "@/services/changeTicketStatus";
import { classifyManually } from "@/services/classifyManually";
import { classifyTicket } from "@/services/classifyTicket";
import { createTicket } from "@/services/createTicket";
import { respondToResolution } from "@/services/respondToResolution";
import { listNotifications, openNotification } from "@/services/notifications";
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

// A Ticket waiting for the AI (no Category), which belongs to service_desk.
async function newTicket(
  requesterId?: string,
  description = "Somebody on the desk should pick this up.",
) {
  const result = await createTicket(
    db,
    {
      requesterId: requesterId ?? (await newUser()),
      idempotencyKey: randomUUID(),
      title: "Notify me",
      description,
    },
    integrationActor,
  );
  if (result.kind !== "created") throw new Error("not created");
  return result.ticket;
}

// Team members also hear about Tickets other test files route to their Team,
// so assertions look at one Ticket only.
async function kindsAbout(userId: string, ticketId: string) {
  const { notifications } = await listNotifications(db, userId);
  return notifications
    .filter((n) => n.ticketId === ticketId)
    .map((n) => n.kind);
}

const classifyJob = (ticketId: string) => ({
  ticketId,
  attempts: 1,
  maxAttempts: 3,
});

const ERP_BLOCKER =
  "I haven't been able to access SAP since this morning, and I need to process some invoices.";

describe("assignment Notifications", () => {
  it("notifies the new Assignee when a Ticket is reassigned to them", async () => {
    const ticket = await newTicket();
    const lead = await newUser(["service_desk"]);
    const operator = await newUser(["service_desk"]);

    await reassignTicket(
      db,
      ticket.id,
      { assigneeId: operator },
      userActor(lead),
    );

    expect(await kindsAbout(operator, ticket.id)).toEqual(["assigned_to_you"]);
  });

  it("tells the Requester their Ticket was taken, but not the Operator who took it", async () => {
    const requester = await newUser();
    const ticket = await newTicket(requester);
    const operator = await newUser(["service_desk"]);

    await takeTicket(db, ticket.id, userActor(operator));

    expect(await kindsAbout(requester, ticket.id)).toEqual(["ticket_assigned"]);
    expect(await kindsAbout(operator, ticket.id)).toEqual([]);
  });

  it("does not notify again when a take or reassignment is retried", async () => {
    const requester = await newUser();
    const ticket = await newTicket(requester);
    const lead = await newUser(["service_desk"]);
    const operator = await newUser(["service_desk"]);

    await takeTicket(db, ticket.id, userActor(operator));
    await takeTicket(db, ticket.id, userActor(operator));
    await reassignTicket(
      db,
      ticket.id,
      { assigneeId: lead },
      userActor(operator),
    );
    await reassignTicket(
      db,
      ticket.id,
      { assigneeId: lead },
      userActor(operator),
    );

    expect(await kindsAbout(requester, ticket.id)).toEqual([
      "ticket_assigned",
      "ticket_assigned",
    ]);
    expect(await kindsAbout(lead, ticket.id)).toEqual(["assigned_to_you"]);
  });

  it("does not notify anyone when a Ticket is released", async () => {
    const requester = await newUser();
    const ticket = await newTicket(requester);
    const lead = await newUser(["service_desk"]);
    const operator = await newUser(["service_desk"]);
    await reassignTicket(
      db,
      ticket.id,
      { assigneeId: operator },
      userActor(lead),
    );

    await releaseTicket(db, ticket.id, userActor(lead));

    expect(await kindsAbout(operator, ticket.id)).toEqual(["assigned_to_you"]);
    expect(await kindsAbout(requester, ticket.id)).toEqual(["ticket_assigned"]);
  });
});

describe("Team queue Notifications", () => {
  it("tells the Team's Operators when the AI routes a Ticket to their queue", async () => {
    const itOperator = await newUser(["it_systems"]);
    const deskOperator = await newUser(["service_desk"]);
    const ticket = await newTicket(undefined, ERP_BLOCKER);

    await classifyTicket(db, new FakeClassifier(), classifyJob(ticket.id));

    expect(await kindsAbout(itOperator, ticket.id)).toEqual([
      "entered_team_queue",
    ]);
    expect(await kindsAbout(deskOperator, ticket.id)).toEqual([]);
  });

  it("tells service_desk when the AI sends a Ticket to Manual Review", async () => {
    const deskOperator = await newUser(["service_desk"]);
    const ticket = await newTicket();

    await classifyTicket(
      db,
      new FakeClassifier("invalid"),
      classifyJob(ticket.id),
    );

    expect(await kindsAbout(deskOperator, ticket.id)).toEqual([
      "entered_team_queue",
    ]);
  });

  it("tells the new Team when a manual classification moves the Ticket, but not the Operator who did it", async () => {
    // In both Teams: hears of the Manual Review, not of their own move.
    const deskOperator = await newUser(["service_desk", "data_team"]);
    const dataOperator = await newUser(["data_team"]);
    const ticket = await newTicket();
    await classifyTicket(
      db,
      new FakeClassifier("invalid"),
      classifyJob(ticket.id),
    );

    const facts = {
      category: "data",
      summary: "Wrong figures in a report",
      blocks_work: false,
      impact_scope: "team",
      reason: "Reported data is wrong.",
    };
    await classifyManually(db, ticket.id, facts, userActor(deskOperator));
    // Correcting the facts without changing the Team is no queue entry.
    await classifyManually(
      db,
      ticket.id,
      { ...facts, blocks_work: true },
      userActor(dataOperator),
    );

    expect(await kindsAbout(dataOperator, ticket.id)).toEqual([
      "entered_team_queue",
    ]);
    expect(await kindsAbout(deskOperator, ticket.id)).toEqual([
      "entered_team_queue",
    ]);
  });
});

describe("reading Notifications", () => {
  it("opening a Notification marks it read and leads to its Ticket", async () => {
    const requester = await newUser();
    const ticket = await newTicket(requester);
    const operator = userActor(await newUser(["service_desk"]));
    await changeTicketStatus(db, ticket.id, { status: "resolved" }, operator);
    await changeTicketStatus(db, ticket.id, { status: "closed" }, operator);
    const before = await listNotifications(db, requester);
    expect(before.unreadCount).toBe(2);

    const opened = await openNotification(
      db,
      requester,
      before.notifications[0]!.id,
    );

    expect(opened).toEqual({ kind: "ok", ticketId: ticket.id });
    const after = await listNotifications(db, requester);
    expect(after.unreadCount).toBe(1);
    expect(after.notifications.map((n) => n.readAt !== null)).toEqual([
      true,
      false,
    ]);
  });

  it("a User cannot open, or even see, another User's Notification", async () => {
    const requester = await newUser();
    const ticket = await newTicket(requester);
    const stranger = await newUser();
    await changeTicketStatus(
      db,
      ticket.id,
      { status: "resolved" },
      userActor(await newUser(["service_desk"])),
    );
    const [notification] = (await listNotifications(db, requester))
      .notifications;

    expect(await openNotification(db, stranger, notification!.id)).toEqual({
      kind: "not_found",
    });
    expect(await listNotifications(db, stranger)).toEqual({
      notifications: [],
      unreadCount: 0,
    });
    expect((await listNotifications(db, requester)).unreadCount).toBe(1);
  });
});

describe("Ticket Status Notifications", () => {
  it("tells the Requester when an Operator resolves and then closes their Ticket", async () => {
    const requester = await newUser();
    const ticket = await newTicket(requester);
    const operator = userActor(await newUser(["service_desk"]));

    await changeTicketStatus(db, ticket.id, { status: "resolved" }, operator);
    await changeTicketStatus(db, ticket.id, { status: "resolved" }, operator);
    await changeTicketStatus(db, ticket.id, { status: "closed" }, operator);

    expect(await kindsAbout(requester, ticket.id)).toEqual([
      "ticket_closed",
      "ticket_resolved",
    ]);
  });

  it("does not notify the Requester of their own close, nor anyone of a reopen", async () => {
    const requester = await newUser();
    const ticket = await newTicket(requester);
    const operator = userActor(await newUser(["service_desk"]));
    await changeTicketStatus(db, ticket.id, { status: "resolved" }, operator);

    await respondToResolution(
      db,
      ticket.id,
      { response: "reopen", reason: "Still broken" },
      userActor(requester),
    );
    await changeTicketStatus(db, ticket.id, { status: "resolved" }, operator);
    await respondToResolution(
      db,
      ticket.id,
      { response: "close", reason: "Fixed" },
      userActor(requester),
    );

    expect(await kindsAbout(requester, ticket.id)).toEqual([
      "ticket_resolved",
      "ticket_resolved",
    ]);
  });
});
