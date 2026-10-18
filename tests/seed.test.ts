import { asc, eq, inArray, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { TicketEvent } from "@/domain/ticketEvents";
import {
  accounts,
  dispatches,
  users,
  teamMemberships,
  ticketEvents,
  tickets,
} from "@/infra/db/schema";
import { seedDatabase } from "@/infra/db/seed";
import { connectTestDb } from "./support/db";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

// Other test files share the database; seeded rows are the only ones using
// the @flowdesk.example domain.
async function seededRows() {
  const people = await db
    .select()
    .from(users)
    .where(like(users.email, "%@flowdesk.example"))
    .orderBy(asc(users.email));
  const ids = people.map((p) => p.id);
  const ticketRows = await db
    .select()
    .from(tickets)
    .where(inArray(tickets.requesterId, ids))
    .orderBy(asc(tickets.number));
  const ticketIds = ticketRows.map((t) => t.id);
  return {
    requesters: people,
    tickets: ticketRows,
    dispatches: await db
      .select()
      .from(dispatches)
      .where(inArray(dispatches.ticketId, ticketIds))
      .orderBy(asc(dispatches.id)),
    events: await db
      .select()
      .from(ticketEvents)
      .where(inArray(ticketEvents.ticketId, ticketIds))
      .orderBy(asc(ticketEvents.id)),
  };
}

describe("seedDatabase", () => {
  it("creates fictional Users and Tickets in varied states", async () => {
    await seedDatabase(db);
    const seeded = await seededRows();

    expect(seeded.requesters).toHaveLength(11);
    expect(new Set(seeded.tickets.map((t) => t.classificationState))).toEqual(
      new Set(["pending", "classified", "needs_review"]),
    );
    expect(new Set(seeded.tickets.map((t) => t.status))).toEqual(
      new Set(["open", "resolved", "closed"]),
    );
    expect(seeded.tickets.some((t) => t.priorityOverrideReason)).toBe(true);
    expect(new Set(seeded.dispatches.map((d) => d.status))).toEqual(
      new Set(["succeeded", "failed"]),
    );
    // Every seeded Ticket has a history, starting with its creation.
    for (const ticket of seeded.tickets) {
      const history = seeded.events.filter((e) => e.ticketId === ticket.id);
      expect(history[0]?.type).toBe("ticket_created");
    }
  });

  it("seeds events whose data matches their type", async () => {
    await seedDatabase(db);
    const seeded = await seededRows();

    for (const { type, data } of seeded.events) {
      expect(TicketEvent.safeParse({ type, data }).error).toBeUndefined();
    }
  });

  it("attributes seeded events to a User, the system or nobody else", async () => {
    await seedDatabase(db);
    const seeded = await seededRows();
    const operatorIds = new Set(
      (
        await db
          .select({ userId: teamMemberships.userId })
          .from(teamMemberships)
      ).map((m) => m.userId),
    );

    expect(new Set(seeded.events.map((e) => e.actor))).toEqual(
      new Set(["system", "user"]),
    );
    for (const event of seeded.events) {
      if (event.actor !== "user") continue;
      const ticket = seeded.tickets.find((t) => t.id === event.ticketId)!;
      expect(
        event.type === "ticket_created"
          ? event.actorUserId === ticket.requesterId
          : operatorIds.has(event.actorUserId!),
      ).toBe(true);
    }
  });

  it("seeds Users with no Team, one Team and two Teams", async () => {
    await seedDatabase(db);
    const memberships = await db
      .select({ email: users.email, team: teamMemberships.team })
      .from(teamMemberships)
      .innerJoin(users, eq(users.id, teamMemberships.userId))
      .where(like(users.email, "%@flowdesk.example"));
    const teamsByEmail = new Map<string, string[]>();
    for (const m of memberships) {
      teamsByEmail.set(m.email, [...(teamsByEmail.get(m.email) ?? []), m.team]);
    }

    expect(new Set(memberships.map((m) => m.team))).toEqual(
      new Set(["it_systems", "identity_access", "data_team", "service_desk"]),
    );
    expect([...teamsByEmail.values()].some((m) => m.length === 2)).toBe(true);
    const seeded = await seededRows();
    expect(seeded.requesters.some((u) => !teamsByEmail.has(u.email))).toBe(
      true,
    );
  });

  it("gives every seeded User the demo password credential", async () => {
    await seedDatabase(db);
    const seeded = await seededRows();
    const credentials = await db
      .select()
      .from(accounts)
      .where(
        inArray(
          accounts.userId,
          seeded.requesters.map((u) => u.id),
        ),
      );

    expect(credentials).toHaveLength(seeded.requesters.length);
    for (const credential of credentials) {
      expect(credential.providerId).toBe("credential");
      expect(credential.password).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    }
  });

  it("is idempotent", async () => {
    await seedDatabase(db);
    const before = await seededRows();

    await seedDatabase(db);

    expect(await seededRows()).toEqual(before);
  });
});
