import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as postRetry } from "@/app/api/dispatches/[id]/retry/route";
import { connectTestDb } from "./support/db";
import { dispatchFixtures } from "./support/dispatchFixtures";
import { startN8nStub } from "./support/n8nStub";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const API_KEY = "test-api-key";
const { sql, db } = connectTestDb();
const { classifiedTicket, runDispatch, snapshot } = dispatchFixtures(db, sql);

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.FLOWDESK_API_KEY = API_KEY;
});
afterAll(() => sql.end());

function retry(id: string, headers: Record<string, string> = {}) {
  return postRetry(
    new Request(`http://localhost/api/dispatches/${id}/retry`, {
      method: "POST",
      headers: { "X-API-Key": API_KEY, ...headers },
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function failedDispatch() {
  const ticket = await classifiedTicket();
  const stub = await startN8nStub({ respond: () => 503 });
  for (let i = 0; i < 3; i++) await runDispatch(ticket.id, stub.url);
  await stub.close();
  return snapshot(ticket.id);
}

describe("POST /api/dispatches/:id/retry", () => {
  it("puts a failed Dispatch back to pending with a new dispatch job, same id", async () => {
    const before = await failedDispatch();
    expect(before.dispatch.status).toBe("failed");

    const response = await retry(before.dispatch.id);

    expect(response.status).toBe(202);
    const after = await snapshot(before.ticket.id);
    expect(after.dispatch).toMatchObject({
      id: before.dispatch.id,
      status: "pending",
    });
    expect(after.jobs.map((j) => j.status).sort()).toEqual(["done", "queued"]);
    expect(after.events.at(-1)).toMatchObject({
      type: "dispatch_retried",
      actor: "human",
      data: { dispatchId: before.dispatch.id },
    });
  });

  it("records the next attempt as manual and sends once, whatever the outcome", async () => {
    const before = await failedDispatch();
    await retry(before.dispatch.id);
    const stub = await startN8nStub({ respond: () => 503 });

    await runDispatch(before.ticket.id, stub.url);
    await stub.close();

    const after = await snapshot(before.ticket.id);
    expect(after.attempts.map((a) => [a.attemptNo, a.trigger])).toEqual([
      [1, "auto"],
      [2, "auto"],
      [3, "auto"],
      [4, "manual"],
    ]);
    // A failed manual attempt is not auto-retried.
    expect(after.dispatch.status).toBe("failed");
    expect(after.jobs.map((j) => j.status).sort()).toEqual(["done", "done"]);
  });

  it.each(["pending", "sent", "succeeded", "unknown"] as const)(
    "answers 409 for a %s Dispatch",
    async (status) => {
      const ticket = await classifiedTicket();
      const stub = await startN8nStub();
      await runDispatch(ticket.id, stub.url);
      await stub.close();
      const { dispatch } = await snapshot(ticket.id);
      await sql`update dispatches set status = ${status} where id = ${dispatch.id}`;

      const response = await retry(dispatch.id);

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("not_retryable");
    },
  );

  it("answers 404 for an unknown id and 401 without the API key", async () => {
    expect((await retry(randomUUID())).status).toBe(404);
    expect((await retry(randomUUID(), { "X-API-Key": "nope" })).status).toBe(
      401,
    );
  });
});
