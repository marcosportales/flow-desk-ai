import { asc, inArray, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  dispatches,
  requesters,
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
    .from(requesters)
    .where(like(requesters.email, "%@flowdesk.example"))
    .orderBy(asc(requesters.email));
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
  it("creates six fictional Requesters and Tickets in varied states", async () => {
    await seedDatabase(db);
    const seeded = await seededRows();

    expect(seeded.requesters).toHaveLength(6);
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

  it("is idempotent", async () => {
    await seedDatabase(db);
    const before = await seededRows();

    await seedDatabase(db);

    expect(await seededRows()).toEqual(before);
  });
});
