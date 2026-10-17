import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as postClassification } from "@/app/api/tickets/[id]/classification/route";
import { POST as postRerun } from "@/app/api/tickets/[id]/classification/rerun/route";
import { POST as postOverride } from "@/app/api/tickets/[id]/priority-override/route";
import { POST as postStatus } from "@/app/api/tickets/[id]/status/route";
import { connectTestDb } from "./support/db";
import { dispatchFixtures } from "./support/dispatchFixtures";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const API_KEY = "test-api-key";
const { sql, db } = connectTestDb();
const { classifiedTicket } = dispatchFixtures(db, sql);

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.FLOWDESK_API_KEY = API_KEY;
});
afterAll(() => sql.end());

type Handler = typeof postClassification;
function call(
  handler: Handler,
  id: string,
  body?: unknown,
  headers: Record<string, string> = { "X-API-Key": API_KEY },
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

describe("manual Ticket action endpoints", () => {
  it("answer 401 without the API key and 404 for an unknown Ticket", async () => {
    const valid: [Handler, unknown][] = [
      [
        postClassification,
        {
          category: "erp",
          summary: "s",
          blocks_work: true,
          impact_scope: "team",
          reason: "r",
        },
      ],
      [postRerun, undefined],
      [postOverride, { priority: "low", reason: "r" }],
      [postStatus, { status: "resolved" }],
    ];
    for (const [handler, body] of valid) {
      expect((await call(handler, randomUUID(), body, {})).status).toBe(401);
      expect((await call(handler, randomUUID(), body)).status).toBe(404);
      expect((await call(handler, "not-a-uuid", body)).status).toBe(404);
    }
  });

  it("rejects a Priority Override without a reason with 422", async () => {
    const ticket = await classifiedTicket();

    const response = await call(postOverride, ticket.id, { priority: "low" });

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_error");
  });

  it("applies an override with a reason", async () => {
    const ticket = await classifiedTicket();

    const response = await call(postOverride, ticket.id, {
      priority: "low",
      reason: "Workaround found",
    });

    expect(response.status).toBe(200);
  });

  it("rejects an illegal status transition with 409", async () => {
    const ticket = await classifiedTicket();

    const response = await call(postStatus, ticket.id, { status: "closed" });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("illegal_transition");
  });

  it("refuses a re-run unless the Ticket needs review (409)", async () => {
    const ticket = await classifiedTicket();
    expect((await call(postRerun, ticket.id)).status).toBe(409);
  });

  it("rejects invalid facts with 422 and a non-JSON body with 422", async () => {
    const ticket = await classifiedTicket();
    expect(
      (await call(postClassification, ticket.id, { category: "erp" })).status,
    ).toBe(422);
    const bad = await postClassification(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "X-API-Key": API_KEY },
        body: "nope",
      }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(bad.status).toBe(422);
  });
});
