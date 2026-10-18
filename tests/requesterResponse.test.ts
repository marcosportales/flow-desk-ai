import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { POST as postRequesterStatus } from "@/app/api/tickets/[id]/requester-status/route";
import { integrationActor } from "@/domain/actor";
import { canCloseOrReopen } from "@/domain/permissions";
import type { Team } from "@/domain/routing";
import {
  teamMemberships,
  ticketEvents,
  tickets,
  users,
} from "@/infra/db/schema";
import { createTicket } from "@/services/createTicket";
import { connectTestDb } from "./support/db";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/infra/auth/session", () => ({
  getRequestUser: async () => session.user,
  requireUser: async () => session.user,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requesterStatusAction } from "@/app/tickets/[id]/actions";

const { sql, db } = connectTestDb();

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
});
beforeEach(() => {
  session.user = null;
});
afterAll(() => sql.end());

async function newUser(teams: Team[] = []) {
  const [row] = await db
    .insert(users)
    .values({ name: "U", email: `${randomUUID()}@t.example`, department: "QA" })
    .returning();
  for (const team of teams) {
    await db.insert(teamMemberships).values({ userId: row!.id, team });
  }
  return row!;
}

async function newTicket(status: "open" | "resolved" | "closed" = "resolved") {
  const requester = await newUser();
  const result = await createTicket(
    db,
    {
      requesterId: requester.id,
      idempotencyKey: randomUUID(),
      title: "Printer fixed?",
      description: "The Requester confirms or disputes the fix.",
    },
    integrationActor,
  );
  if (result.kind !== "created") throw new Error("not created");
  await db
    .update(tickets)
    .set({ status })
    .where(eq(tickets.id, result.ticket.id));
  return { id: result.ticket.id, requester };
}

function call(id: string, body: unknown, headers: Record<string, string> = {}) {
  return postRequesterStatus(
    new Request("http://localhost/api/tickets/x/requester-status", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function statusOf(id: string) {
  const [row] = await db.select().from(tickets).where(eq(tickets.id, id));
  return row!.status;
}

describe("canCloseOrReopen", () => {
  const ticket = {
    requesterId: "ana",
    category: "erp",
    team: "it_systems",
  } as const;

  it("is true only for the Ticket's own Requester", () => {
    expect(canCloseOrReopen({ id: "ana", teams: [] }, ticket)).toBe(true);
    expect(canCloseOrReopen({ id: "ben", teams: [] }, ticket)).toBe(false);
    expect(
      canCloseOrReopen({ id: "grace", teams: ["it_systems"] }, ticket),
    ).toBe(false);
  });
});

describe("requester-status endpoint", () => {
  it("answers 401 without a session and 403 for an API key", async () => {
    const { id } = await newTicket();
    expect((await call(id, { response: "close", reason: "ok" })).status).toBe(
      401,
    );
    expect(
      (
        await call(
          id,
          { response: "close", reason: "ok" },
          { "x-api-key": "k" },
        )
      ).status,
    ).toBe(403);
    expect(await statusOf(id)).toBe("resolved");
  });

  it("lets the Requester close their own resolved Ticket, recording reason and actor", async () => {
    const { id, requester } = await newTicket();
    session.user = { id: requester.id };

    const res = await call(id, { response: "close", reason: "Works now" });

    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe("closed");
    const events = await db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, id))
      .orderBy(asc(ticketEvents.id));
    expect(events.at(-1)).toMatchObject({
      type: "status_changed",
      actor: "user",
      actorUserId: requester.id,
      data: { from: "resolved", to: "closed", reason: "Works now" },
    });
  });

  it("lets the Requester reopen their own resolved Ticket", async () => {
    const { id, requester } = await newTicket();
    session.user = { id: requester.id };

    const res = await call(id, { response: "reopen", reason: "Still broken" });

    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe("open");
  });

  it("forbids another User, even an Operator of the Ticket's Team", async () => {
    const { id } = await newTicket();
    for (const other of [await newUser(), await newUser(["service_desk"])]) {
      session.user = { id: other.id };
      const res = await call(id, { response: "close", reason: "x" });
      expect(res.status).toBe(403);
    }
    expect(await statusOf(id)).toBe("resolved");
  });

  it("requires a reason", async () => {
    const { id, requester } = await newTicket();
    session.user = { id: requester.id };
    expect((await call(id, { response: "close", reason: "  " })).status).toBe(
      422,
    );
    expect((await call(id, { response: "close" })).status).toBe(422);
    expect(await statusOf(id)).toBe("resolved");
  });

  it("keeps to the existing Ticket Status transitions", async () => {
    const open = await newTicket("open");
    session.user = { id: open.requester.id };
    expect(
      (await call(open.id, { response: "close", reason: "x" })).status,
    ).toBe(409);

    const closed = await newTicket("closed");
    session.user = { id: closed.requester.id };
    expect(
      (await call(closed.id, { response: "reopen", reason: "x" })).status,
    ).toBe(409);
  });

  it("answers 404 for an unknown Ticket", async () => {
    session.user = { id: (await newUser()).id };
    expect(
      (await call(randomUUID(), { response: "close", reason: "x" })).status,
    ).toBe(404);
  });
});

describe("requesterStatusAction", () => {
  const form = (ticketId: string, response: string, reason: string) => {
    const data = new FormData();
    data.set("ticketId", ticketId);
    data.set("response", response);
    data.set("reason", reason);
    return data;
  };

  it("closes for the Requester and refuses everyone else", async () => {
    const { id, requester } = await newTicket();

    session.user = { id: (await newUser(["service_desk"])).id };
    const denied = await requesterStatusAction(
      { status: "idle" },
      form(id, "close", "x"),
    );
    expect(denied.status).toBe("error");
    expect(await statusOf(id)).toBe("resolved");

    session.user = { id: requester.id };
    const ok = await requesterStatusAction(
      { status: "idle" },
      form(id, "close", "Works now"),
    );
    expect(ok.status).toBe("ok");
    expect(await statusOf(id)).toBe("closed");
  });
});
