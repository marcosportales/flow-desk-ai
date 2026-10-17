import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/tickets/[id]/route";
import { requesters, tickets } from "@/infra/db/schema";
import { connectTestDb } from "./support/db";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const API_KEY = "test-api-key";
const { sql, db } = connectTestDb();

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.FLOWDESK_API_KEY = API_KEY;
});
afterAll(() => sql.end());

const call = (id: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/api/tickets/${id}`, { headers }), {
    params: Promise.resolve({ id }),
  });
const authed = { "X-API-Key": API_KEY };

describe("GET /api/tickets/:id", () => {
  it("rejects a missing API key", async () => {
    expect((await call(randomUUID())).status).toBe(401);
  });

  it("404s for an unknown or malformed id", async () => {
    expect((await call(randomUUID(), authed)).status).toBe(404);
    const res = await call("not-a-uuid", authed);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("returns the Ticket detail without idempotency internals", async () => {
    const [requester] = await db
      .insert(requesters)
      .values({
        name: "Api Detail",
        email: `${randomUUID()}@test.example`,
        department: "QA",
      })
      .returning();
    const [ticket] = await db
      .insert(tickets)
      .values({
        requesterId: requester!.id,
        title: "Detail via API",
        description: "A description that is long enough.",
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      })
      .returning();

    const res = await call(ticket!.id, authed);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.id).toBe(ticket!.id);
    expect(body.ticket).not.toHaveProperty("requestHash");
    expect(body.ticket).not.toHaveProperty("idempotencyKey");
    expect(body.dispatches).toEqual([]);
    expect(body.events).toEqual([]);
  });
});
