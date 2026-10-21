import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as postRetry } from "@/app/api/dispatches/[id]/retry/route";
import { POST as postCallback } from "@/app/api/webhooks/n8n/route";
import { signBody } from "@/infra/crypto/hmac";
import { dispatches, teamMemberships, tickets, users } from "@/infra/db/schema";
import { connectTestDb } from "./support/db";
import { dispatchFixtures, FROM_N8N_SECRET } from "./support/dispatchFixtures";
import { startN8nStub } from "./support/n8nStub";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/infra/auth/session", () => ({
  getRequestUser: async () => session.user,
}));

const { sql, db } = connectTestDb();
const { classifiedTicket, runDispatch, snapshot } = dispatchFixtures(db, sql);

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.FLOWDESK_API_KEY = "test-api-key";
  process.env.N8N_TO_FLOWDESK_SECRET = FROM_N8N_SECRET;
});
afterAll(() => sql.end());

// Scenario C: n8n is down for a Dispatch, then recovers.
describe("Scenario C: failed Dispatch, manual retry", () => {
  it("fails after three attempts, then a manual retry delivers it under the same dispatch_id", async () => {
    const ticket = await classifiedTicket();
    const down = await startN8nStub({ respond: () => 503 });
    for (let i = 0; i < 3; i++) await runDispatch(ticket.id, down.url);
    await down.close();
    const failed = await snapshot(ticket.id);
    expect(failed.dispatch.status).toBe("failed");

    const [operator] = await db
      .insert(users)
      .values({
        name: "Op",
        email: `${failed.ticket.id}@t.example`,
        department: "QA",
      })
      .returning();
    await db
      .insert(teamMemberships)
      .values({ userId: operator!.id, team: "it_systems" });
    session.user = operator!;

    const retried = await postRetry(
      new Request("http://localhost/api/dispatches/x/retry", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: failed.dispatch.id }) },
    );
    expect(retried.status).toBe(202);

    const up = await startN8nStub();
    await runDispatch(ticket.id, up.url);
    await up.close();
    expect(JSON.parse(up.requests[0]!.body).dispatch_id).toBe(
      failed.dispatch.id,
    );

    const raw = JSON.stringify({
      dispatch_id: failed.dispatch.id,
      outcome: "succeeded",
      execution_reference: "exec-c",
    });
    await postCallback(
      new Request("http://localhost/api/webhooks/n8n", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signBody(FROM_N8N_SECRET, raw),
        },
        body: raw,
      }),
    );

    const done = await snapshot(ticket.id);
    expect(done.dispatch).toMatchObject({
      id: failed.dispatch.id,
      status: "succeeded",
    });
    expect(
      done.attempts.map((a) => [a.attemptNo, a.trigger, a.outcome]),
    ).toEqual([
      [1, "auto", "failed"],
      [2, "auto", "failed"],
      [3, "auto", "failed"],
      [4, "manual", "succeeded"],
    ]);
    expect(
      await db
        .select()
        .from(dispatches)
        .where(eq(dispatches.ticketId, ticket.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(tickets).where(eq(tickets.id, ticket.id)),
    ).toHaveLength(1);
  });
});
