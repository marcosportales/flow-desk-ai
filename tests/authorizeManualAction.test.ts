import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatches, teamMemberships, users } from "@/infra/db/schema";
import { authorizeManualAction } from "@/services/authorizeManualAction";
import { connectTestDb } from "./support/db";
import { dispatchFixtures } from "./support/dispatchFixtures";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const { sql, db } = connectTestDb();
const { classifiedTicket } = dispatchFixtures(db, sql);

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
});
afterAll(() => sql.end());

async function user(teams: ("it_systems" | "service_desk")[] = []) {
  const [row] = await db
    .insert(users)
    .values({ name: "U", email: `${randomUUID()}@t.example`, department: "QA" })
    .returning();
  if (teams.length) {
    await db
      .insert(teamMemberships)
      .values(teams.map((team) => ({ userId: row!.id, team })));
  }
  return row!;
}

describe("authorizeManualAction", () => {
  it("allows an Operator of the Ticket's Team", async () => {
    const ticket = await classifiedTicket(); // erp -> it_systems
    const operator = await user(["it_systems"]);
    expect(
      await authorizeManualAction(db, operator.id, { ticketId: ticket.id }),
    ).toBe("allowed");
  });

  it("forbids a User in another Team", async () => {
    const ticket = await classifiedTicket();
    const other = await user(["service_desk"]);
    expect(
      await authorizeManualAction(db, other.id, { ticketId: ticket.id }),
    ).toBe("forbidden");
  });

  it("forbids the Requester when they are not an Operator", async () => {
    const ticket = await classifiedTicket();
    expect(
      await authorizeManualAction(db, ticket.requesterId, {
        ticketId: ticket.id,
      }),
    ).toBe("forbidden");
  });

  it("allows a Requester who is also a Team member", async () => {
    const ticket = await classifiedTicket();
    await db
      .insert(teamMemberships)
      .values({ userId: ticket.requesterId, team: "it_systems" });
    expect(
      await authorizeManualAction(db, ticket.requesterId, {
        ticketId: ticket.id,
      }),
    ).toBe("allowed");
  });

  it("resolves a Dispatch to its Ticket", async () => {
    const ticket = await classifiedTicket();
    const [dispatch] = await db
      .select()
      .from(dispatches)
      .where(eq(dispatches.ticketId, ticket.id));
    const operator = await user(["it_systems"]);
    const outsider = await user();
    expect(
      await authorizeManualAction(db, operator.id, {
        dispatchId: dispatch!.id,
      }),
    ).toBe("allowed");
    expect(
      await authorizeManualAction(db, outsider.id, {
        dispatchId: dispatch!.id,
      }),
    ).toBe("forbidden");
  });

  it("reports not_found for an unknown Ticket or Dispatch", async () => {
    const operator = await user(["it_systems"]);
    expect(
      await authorizeManualAction(db, operator.id, { ticketId: randomUUID() }),
    ).toBe("not_found");
    expect(
      await authorizeManualAction(db, operator.id, {
        dispatchId: randomUUID(),
      }),
    ).toBe("not_found");
  });
});
