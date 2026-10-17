import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { requesters, tickets } from "@/infra/db/schema";
import { createTicket } from "@/services/createTicket";
import { connectTestDb } from "./support/db";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

import { statusAction } from "@/app/tickets/[id]/actions";

const { sql, db } = connectTestDb();

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
});
beforeEach(() => revalidatePath.mockClear());
afterAll(() => sql.end());

async function newTicket() {
  const [requester] = await db
    .insert(requesters)
    .values({ name: "R", email: `${randomUUID()}@t.example`, department: "QA" })
    .returning();
  const result = await createTicket(db, {
    requesterId: requester!.id,
    idempotencyKey: randomUUID(),
    title: "Status refresh",
    description: "Changing status must show up without a reload.",
  });
  if (result.kind !== "created") throw new Error("not created");
  return result.ticket;
}

function form(ticketId: string, status: string) {
  const data = new FormData();
  data.set("ticketId", ticketId);
  data.set("status", status);
  return data;
}

describe("statusAction", () => {
  it("revalidates both the Ticket page and the Tickets list after a status change", async () => {
    const ticket = await newTicket();

    const state = await statusAction(
      { status: "idle" },
      form(ticket.id, "resolved"),
    );

    expect(state.status).toBe("ok");
    const [row] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticket.id));
    expect(row!.status).toBe("resolved");
    expect(revalidatePath).toHaveBeenCalledWith(`/tickets/${ticket.id}`);
    expect(revalidatePath).toHaveBeenCalledWith("/tickets");
  });

  it("does not revalidate when the change is rejected", async () => {
    const ticket = await newTicket();

    const state = await statusAction(
      { status: "idle" },
      form(ticket.id, "closed"),
    );

    expect(state.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
