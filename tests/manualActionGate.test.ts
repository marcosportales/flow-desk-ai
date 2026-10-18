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
import { POST as postRetry } from "@/app/api/dispatches/[id]/retry/route";
import { POST as postTake } from "@/app/api/tickets/[id]/take/route";
import { dispatches, jobs, teamMemberships, users } from "@/infra/db/schema";
import { connectTestDb } from "./support/db";
import { dispatchFixtures } from "./support/dispatchFixtures";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/infra/auth/session", () => ({
  getRequestUser: async () => session.user,
}));

const { sql, db } = connectTestDb();
const { classifiedTicket } = dispatchFixtures(db, sql);

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
});
beforeEach(() => {
  session.user = null;
  revalidatePath.mockClear();
});
afterAll(() => sql.end());

async function signInAs(teams: "it_systems"[] = []) {
  const [row] = await db
    .insert(users)
    .values({ name: "U", email: `${randomUUID()}@t.example`, department: "QA" })
    .returning();
  for (const team of teams) {
    await db.insert(teamMemberships).values({ userId: row!.id, team });
  }
  session.user = { id: row!.id };
}

function post(handler: typeof postTake, path: string, id: string) {
  return handler(new Request(`http://localhost${path}`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

describe("Manual Action routes revalidate the Ticket pages", () => {
  it("revalidates the list and the Ticket after a successful action", async () => {
    const ticket = await classifiedTicket(); // erp -> it_systems
    await signInAs(["it_systems"]);

    const response = await post(postTake, "/take", ticket.id);

    expect(response.status).toBe(200);
    expect(revalidatePath).toHaveBeenCalledWith("/tickets");
    expect(revalidatePath).toHaveBeenCalledWith(`/tickets/${ticket.id}`);
  });

  it("revalidates nothing when the caller is refused", async () => {
    const ticket = await classifiedTicket();
    await signInAs();

    const response = await post(postTake, "/take", ticket.id);

    expect(response.status).toBe(403);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates the Dispatch's own Ticket after a retry", async () => {
    const ticket = await classifiedTicket();
    const [dispatch] = await db
      .update(dispatches)
      .set({ status: "failed" })
      .where(eq(dispatches.ticketId, ticket.id))
      .returning();
    await db
      .update(jobs)
      .set({ status: "done" })
      .where(eq(jobs.ticketId, ticket.id));
    await signInAs(["it_systems"]);

    const response = await post(postRetry, "/retry", dispatch!.id);

    expect(response.status).toBe(202);
    expect(revalidatePath).toHaveBeenCalledWith(`/tickets/${ticket.id}`);
    const [after] = await db
      .select({ status: dispatches.status })
      .from(dispatches)
      .where(eq(dispatches.id, dispatch!.id));
    expect(after!.status).toBe("pending");
  });
});
