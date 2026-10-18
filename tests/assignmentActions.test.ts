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
import { integrationActor } from "@/domain/actor";
import type { Team } from "@/domain/routing";
import { teamMemberships, tickets, users } from "@/infra/db/schema";
import { createTicket } from "@/services/createTicket";
import { listTeamMembers } from "@/services/listTeamMembers";
import { connectTestDb } from "./support/db";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

const requireUser = vi.hoisted(() => vi.fn());
vi.mock("@/infra/auth/session", () => ({ requireUser }));

import {
  reassignAction,
  releaseAction,
  takeAction,
} from "@/app/tickets/[id]/actions";

const { sql, db } = connectTestDb();

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
});
beforeEach(() => {
  revalidatePath.mockClear();
  requireUser.mockReset();
});
afterAll(() => sql.end());

async function newUser(teams: Team[] = [], name = "U") {
  const [row] = await db
    .insert(users)
    .values({ name, email: `${randomUUID()}@t.example`, department: "QA" })
    .returning();
  for (const team of teams) {
    await db.insert(teamMemberships).values({ userId: row!.id, team });
  }
  return row!.id;
}

async function newTicket() {
  const result = await createTicket(
    db,
    {
      requesterId: await newUser(),
      idempotencyKey: randomUUID(),
      title: "Assign me",
      description: "A Ticket waiting in the service desk queue.",
    },
    integrationActor,
  );
  if (result.kind !== "created") throw new Error("not created");
  return result.ticket.id;
}

function form(ticketId: string, fields: Record<string, string> = {}) {
  const data = new FormData();
  data.set("ticketId", ticketId);
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

async function assigneeOf(id: string) {
  const [row] = await db.select().from(tickets).where(eq(tickets.id, id));
  return row!.assigneeId;
}

const idle = { status: "idle" } as const;

describe("assignment Server Actions", () => {
  it("take, then refuse the next taker with a clear message", async () => {
    const id = await newTicket();
    const first = await newUser(["service_desk"]);
    const second = await newUser(["service_desk"]);

    requireUser.mockResolvedValue({ id: first });
    expect(await takeAction(idle, form(id))).toMatchObject({ status: "ok" });
    expect(revalidatePath).toHaveBeenCalledWith(`/tickets/${id}`);
    expect(revalidatePath).toHaveBeenCalledWith("/tickets");

    requireUser.mockResolvedValue({ id: second });
    expect(await takeAction(idle, form(id))).toEqual({
      status: "error",
      message: "Another Operator already took this Ticket",
    });
    expect(await assigneeOf(id)).toBe(first);
  });

  it("refuse a User who is not an Operator of the Ticket's Team", async () => {
    const id = await newTicket();
    requireUser.mockResolvedValue({ id: await newUser(["data_team"]) });

    for (const result of [
      await takeAction(idle, form(id)),
      await releaseAction(idle, form(id)),
      await reassignAction(idle, form(id, { assigneeId: randomUUID() })),
    ]) {
      expect(result.status).toBe("error");
    }
    expect(await assigneeOf(id)).toBeNull();
  });

  it("release and reassign", async () => {
    const id = await newTicket();
    const operator = await newUser(["service_desk"]);
    const colleague = await newUser(["service_desk"]);
    requireUser.mockResolvedValue({ id: operator });

    await takeAction(idle, form(id));
    expect(
      await reassignAction(idle, form(id, { assigneeId: colleague })),
    ).toMatchObject({ status: "ok" });
    expect(await assigneeOf(id)).toBe(colleague);
    expect(await releaseAction(idle, form(id))).toMatchObject({ status: "ok" });
    expect(await assigneeOf(id)).toBeNull();
  });

  it("reassigning outside the Team shows the reason", async () => {
    const id = await newTicket();
    requireUser.mockResolvedValue({ id: await newUser(["service_desk"]) });
    const outsider = await newUser(["data_team"]);

    const result = await reassignAction(
      idle,
      form(id, { assigneeId: outsider }),
    );

    expect(result).toEqual({
      status: "error",
      message: "assigneeId: Must be a member of the Ticket's Team",
    });
  });
});

describe("listTeamMembers", () => {
  it("lists the members of the Ticket's Team by name", async () => {
    const id = await newTicket();
    const ana = await newUser(["service_desk"], "Ana");
    await newUser(["data_team"], "Outsider");

    const members = await listTeamMembers(db, id);

    expect(members).toContainEqual({ id: ana, name: "Ana" });
    expect(members.map((m) => m.name)).not.toContain("Outsider");
  });
});
