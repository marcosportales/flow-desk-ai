import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ticketEvents, users } from "@/infra/db/schema";
import { GET as listRequesters } from "@/app/api/requesters/route";
import { GET as getTickets, POST as postTicket } from "@/app/api/tickets/route";
import { connectTestDb } from "./support/db";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const API_KEY = "test-api-key";
const { sql, db } = connectTestDb();

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.FLOWDESK_API_KEY = API_KEY;
});
afterAll(() => sql.end());

async function newRequester() {
  const [requester] = await db
    .insert(users)
    .values({
      name: "Api Person",
      email: `${randomUUID()}@test.example`,
      department: "QA",
    })
    .returning();
  return requester!;
}

function post(
  body: unknown,
  headers: Record<string, string> = {},
  raw = false,
) {
  return postTicket(
    new Request("http://localhost/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );
}

const authed = (key = randomUUID()) => ({
  "X-API-Key": API_KEY,
  "Idempotency-Key": key,
});

describe("POST /api/tickets", () => {
  it("returns 202 with the Ticket, then 200 with the same Ticket on replay", async () => {
    const requester = await newRequester();
    const headers = authed();
    const body = {
      requesterId: requester.id,
      title: "Cannot log in",
      description: "The ERP rejects my password since this morning.",
    };

    const first = await post(body, headers);
    const second = await post(body, headers);

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    const a = await first.json();
    const b = await second.json();
    expect(a.ticket.id).toBe(b.ticket.id);
    expect(a.ticket).not.toHaveProperty("requestHash");
    expect(a.ticket).not.toHaveProperty("idempotencyKey");
    expect(a.ticket).toMatchObject({
      title: body.title,
      classificationState: "pending",
    });
  });

  it("records the Integration as the actor of ticket_created", async () => {
    const requester = await newRequester();
    const response = await post(
      {
        requesterId: requester.id,
        title: "Cannot log in",
        description: "The ERP rejects my password since this morning.",
      },
      authed(),
    );
    const { ticket } = await response.json();

    const events = await db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, ticket.id));
    expect(events).toMatchObject([
      { type: "ticket_created", actor: "integration", actorUserId: null },
    ]);
  });

  it("returns 409 when the key is reused with a different body", async () => {
    const requester = await newRequester();
    const headers = authed();
    const body = {
      requesterId: requester.id,
      title: "Cannot log in",
      description: "The ERP rejects my password since this morning.",
    };
    await post(body, headers);

    const res = await post({ ...body, title: "Something else" }, headers);

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("idempotency_conflict");
  });

  it("returns 401 without a valid API key", async () => {
    const body = { requesterId: randomUUID(), title: "abc", description: "x" };
    const attempts: Record<string, string>[] = [
      { "Idempotency-Key": randomUUID() },
      { "X-API-Key": "wrong", "Idempotency-Key": randomUUID() },
    ];
    for (const headers of attempts) {
      const res = await post(body, headers);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("unauthorized");
    }
  });

  it("returns 422 when the Idempotency-Key header is missing", async () => {
    const res = await post({}, { "X-API-Key": API_KEY });

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("validation_error");
  });

  it("returns 422 with details for an invalid body", async () => {
    const requester = await newRequester();
    const res = await post(
      { requesterId: requester.id, title: "ab", description: "short" },
      authed(),
    );

    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe("validation_error");
    expect(error.details.fieldErrors).toHaveProperty("title");
    expect(error.details.fieldErrors).toHaveProperty("description");
  });

  it("returns 422 for a body that is not JSON", async () => {
    const res = await post("{nope", authed(), true);

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("validation_error");
  });
});

describe("GET /api/requesters", () => {
  it("lists Requesters when authorised", async () => {
    const requester = await newRequester();
    const res = await listRequesters(
      new Request("http://localhost/api/requesters", {
        headers: { "X-API-Key": API_KEY },
      }),
    );

    expect(res.status).toBe(200);
    const { requesters: list } = await res.json();
    expect(list.map((r: { id: string }) => r.id)).toContain(requester.id);
    expect(list[0]).toHaveProperty("name");
    expect(list[0]).not.toHaveProperty("email");
  });

  it("returns 401 without the API key", async () => {
    const res = await listRequesters(
      new Request("http://localhost/api/requesters"),
    );

    expect(res.status).toBe(401);
  });
});

describe("GET /api/tickets", () => {
  const get = (search: string, headers: Record<string, string> = {}) =>
    getTickets(
      new Request(`http://localhost/api/tickets${search}`, { headers }),
    );

  it("requires the API key", async () => {
    expect((await get("")).status).toBe(401);
  });

  it("lists Tickets with pagination metadata and applies filters", async () => {
    const requester = await newRequester();
    const title = `Listed ${randomUUID().slice(0, 8)}`;
    await post(
      { requesterId: requester.id, title, description: "Long enough text." },
      authed(),
    );

    const res = await get(`?q=${encodeURIComponent(title)}&status=open`, {
      "X-API-Key": API_KEY,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(body.tickets[0]).toMatchObject({
      title,
      requesterName: "Api Person",
      dispatchStatus: null,
    });
  });

  it("returns 422 for an invalid filter", async () => {
    const res = await get("?status=bogus", { "X-API-Key": API_KEY });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("validation_error");
  });
});
