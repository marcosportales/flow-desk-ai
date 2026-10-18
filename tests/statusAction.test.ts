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
import { dispatches, teamMemberships, users, tickets } from "@/infra/db/schema";
import { createTicket } from "@/services/createTicket";
import { connectTestDb } from "./support/db";
import { dispatchFixtures } from "./support/dispatchFixtures";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

const requireUser = vi.hoisted(() => vi.fn());
vi.mock("@/infra/auth/session", () => ({ requireUser }));

import {
  classifyAction,
  overrideAction,
  rerunAction,
  retryAction,
  statusAction,
} from "@/app/tickets/[id]/actions";

const { sql, db } = connectTestDb();
const { classifiedTicket } = dispatchFixtures(db, sql);

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
});
beforeEach(() => {
  revalidatePath.mockClear();
  requireUser.mockReset();
});
afterAll(() => sql.end());

async function newOperator() {
  const [operator] = await db
    .insert(users)
    .values({ name: "O", email: `${randomUUID()}@t.example`, department: "QA" })
    .returning();
  await db
    .insert(teamMemberships)
    .values({ userId: operator!.id, team: "service_desk" });
  requireUser.mockResolvedValue({ id: operator!.id });
}

async function newTicket() {
  const [requester] = await db
    .insert(users)
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
  it("requires a signed-in User and changes nothing without one", async () => {
    const ticket = await newTicket();
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(
      statusAction({ status: "idle" }, form(ticket.id, "resolved")),
    ).rejects.toThrow("NEXT_REDIRECT");

    const [row] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticket.id));
    expect(row!.status).toBe("open");
  });

  it("revalidates both the Ticket page and the Tickets list after a status change", async () => {
    const ticket = await newTicket();
    await newOperator();

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
    await newOperator();

    const state = await statusAction(
      { status: "idle" },
      form(ticket.id, "closed"),
    );

    expect(state.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a Requester who is not an Operator and changes nothing", async () => {
    const ticket = await newTicket();
    requireUser.mockResolvedValue({ id: ticket.requesterId });

    const state = await statusAction(
      { status: "idle" },
      form(ticket.id, "resolved"),
    );

    expect(state.status).toBe("error");
    const [row] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticket.id));
    expect(row!.status).toBe("open");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a Requester-only User on every Manual Action", async () => {
    const ticket = await newTicket();
    requireUser.mockResolvedValue({ id: ticket.requesterId });
    const data = form(ticket.id, "resolved");

    for (const action of [
      classifyAction,
      rerunAction,
      overrideAction,
      statusAction,
    ]) {
      const state = await action({ status: "idle" }, data);
      expect(state).toMatchObject({ status: "error" });
      expect((state as { message: string }).message).toMatch(/Operator/);
    }
  });

  it("authorizes a Dispatch retry through the Dispatch, not the form's ticketId", async () => {
    const own = await newTicket(); // service_desk
    const other = await classifiedTicket(); // it_systems
    const [dispatch] = await db
      .select()
      .from(dispatches)
      .where(eq(dispatches.ticketId, other.id));
    await newOperator(); // service_desk only
    const data = form(own.id, "resolved");
    data.set("dispatchId", dispatch!.id);

    const state = await retryAction({ status: "idle" }, data);

    expect(state).toMatchObject({ status: "error" });
    expect((state as { message: string }).message).toMatch(/Operator/);
  });
});
