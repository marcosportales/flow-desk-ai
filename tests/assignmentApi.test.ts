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
import { POST as postReassign } from "@/app/api/tickets/[id]/reassign/route";
import { POST as postRelease } from "@/app/api/tickets/[id]/release/route";
import { POST as postTake } from "@/app/api/tickets/[id]/take/route";
import { integrationActor } from "@/domain/actor";
import type { Team } from "@/domain/routing";
import { teamMemberships, tickets, users } from "@/infra/db/schema";
import { createTicket } from "@/services/createTicket";
import { connectTestDb } from "./support/db";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/infra/auth/session", () => ({
  getRequestUser: async () => session.user,
}));

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

async function newTicket() {
  const requester = await newUser();
  const result = await createTicket(
    db,
    {
      requesterId: requester.id,
      idempotencyKey: randomUUID(),
      title: "Assign me",
      description: "A Ticket waiting in the service desk queue.",
    },
    integrationActor,
  );
  if (result.kind !== "created") throw new Error("not created");
  return result.ticket.id;
}

function call(
  handler: typeof postTake,
  id: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return handler(
    new Request("http://localhost/api/tickets/x", {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function assigneeOf(id: string) {
  const [row] = await db.select().from(tickets).where(eq(tickets.id, id));
  return row!.assigneeId;
}

describe("assignment endpoints", () => {
  it("answer 401 without a session and 403 for an API key", async () => {
    const id = await newTicket();
    expect((await call(postTake, id)).status).toBe(401);
    expect(
      (await call(postTake, id, undefined, { "x-api-key": "k" })).status,
    ).toBe(403);
    expect(await assigneeOf(id)).toBeNull();
  });

  it("refuse a User who is not an Operator of the Ticket's Team", async () => {
    const id = await newTicket();
    session.user = await newUser(["data_team"]);
    expect((await call(postTake, id)).status).toBe(403);
    expect(await assigneeOf(id)).toBeNull();
  });

  it("answer 404 for an unknown Ticket", async () => {
    session.user = await newUser(["service_desk"]);
    expect((await call(postTake, randomUUID())).status).toBe(404);
    expect((await call(postTake, "nope")).status).toBe(404);
  });

  it("let an Operator take, and answer 409 to the next taker", async () => {
    const id = await newTicket();
    const first = await newUser(["service_desk"]);
    const second = await newUser(["service_desk"]);

    session.user = first;
    expect((await call(postTake, id)).status).toBe(200);
    session.user = second;
    expect((await call(postTake, id)).status).toBe(409);
    expect(await assigneeOf(id)).toBe(first.id);
  });

  it("release a Ticket, and answer 409 when it has no Assignee", async () => {
    const id = await newTicket();
    session.user = await newUser(["service_desk"]);
    expect((await call(postRelease, id)).status).toBe(409);
    await call(postTake, id);
    expect((await call(postRelease, id)).status).toBe(200);
    expect(await assigneeOf(id)).toBeNull();
  });

  it("reassign within the Team and refuse a User outside it with 422", async () => {
    const id = await newTicket();
    const colleague = await newUser(["service_desk"]);
    const outsider = await newUser(["data_team"]);
    session.user = await newUser(["service_desk"]);

    expect(
      (await call(postReassign, id, { assigneeId: outsider.id })).status,
    ).toBe(422);
    expect(
      (await call(postReassign, id, { assigneeId: colleague.id })).status,
    ).toBe(200);
    expect(await assigneeOf(id)).toBe(colleague.id);
  });
});
