import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as postCallback } from "@/app/api/webhooks/n8n/route";
import { signBody } from "@/infra/crypto/hmac";
import { dispatches } from "@/infra/db/schema";
import { connectTestDb } from "./support/db";
import { dispatchFixtures, FROM_N8N_SECRET } from "./support/dispatchFixtures";
import { startN8nStub } from "./support/n8nStub";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const { sql, db } = connectTestDb();
const { classifiedTicket, runDispatch, snapshot } = dispatchFixtures(db, sql);

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.N8N_TO_FLOWDESK_SECRET = FROM_N8N_SECRET;
});
afterAll(() => sql.end());

// A Ticket whose Dispatch n8n has accepted (`sent`), awaiting its callback.
async function sentDispatch() {
  const ticket = await classifiedTicket();
  const stub = await startN8nStub();
  await runDispatch(ticket.id, stub.url);
  await stub.close();
  return snapshot(ticket.id);
}

function callback(
  body: unknown,
  {
    secret = FROM_N8N_SECRET,
    now = new Date(),
  }: { secret?: string; now?: Date } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return postCallback(
    new Request("http://localhost/api/webhooks/n8n", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signBody(secret, raw, now),
      },
      body: raw,
    }),
  );
}

const succeeded = (dispatchId: string) => ({
  dispatch_id: dispatchId,
  outcome: "succeeded",
  n8n_execution_id: "exec-1",
  delivered_at: "2026-10-17T12:00:01.000Z",
});

describe("POST /api/webhooks/n8n", () => {
  it("settles a sent Dispatch as succeeded, on its attempt, with an event from n8n", async () => {
    const before = await sentDispatch();

    const response = await callback(succeeded(before.dispatch.id));

    expect(response.status).toBe(200);
    const after = await snapshot(before.ticket.id);
    expect(after.dispatch.status).toBe("succeeded");
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]).toMatchObject({
      outcome: "succeeded",
      n8nExecutionId: "exec-1",
      httpStatus: 202,
      error: null,
    });
    expect(after.events.at(-1)).toMatchObject({
      type: "dispatch_succeeded",
      actor: "system",
      data: {
        dispatchId: before.dispatch.id,
        n8nExecutionId: "exec-1",
        deliveredAt: "2026-10-17T12:00:01.000Z",
      },
    });
  });

  it("stores the External Reference the ERP gave back on the Ticket", async () => {
    const before = await sentDispatch();
    expect(before.ticket.externalReference).toBeNull();

    const response = await callback({
      ...succeeded(before.dispatch.id),
      external_reference: "INC-000007",
    });

    expect(response.status).toBe(200);
    const after = await snapshot(before.ticket.id);
    expect(after.dispatch.status).toBe("succeeded");
    expect(after.ticket.externalReference).toBe("INC-000007");
    expect(after.events.at(-1)).toMatchObject({
      type: "dispatch_succeeded",
      data: { externalReference: "INC-000007" },
    });
  });

  it("leaves the External Reference unset when the callback carries none", async () => {
    const before = await sentDispatch();

    await callback(succeeded(before.dispatch.id));

    expect((await snapshot(before.ticket.id)).ticket.externalReference).toBe(
      null,
    );
  });

  it("records n8n's failure and queues an automatic retry while the budget lasts", async () => {
    const before = await sentDispatch();

    const response = await callback({
      dispatch_id: before.dispatch.id,
      outcome: "failed",
      error: "notifier answered 500",
      n8n_execution_id: "exec-2",
    });

    expect(response.status).toBe(200);
    const after = await snapshot(before.ticket.id);
    expect(after.dispatch).toMatchObject({
      id: before.dispatch.id,
      status: "pending",
      autoAttempts: 1,
    });
    expect(after.attempts[0]).toMatchObject({
      outcome: "failed",
      error: "notifier answered 500",
      n8nExecutionId: "exec-2",
    });
    expect(after.jobs.map((j) => j.status).sort()).toEqual(["done", "queued"]);
    expect(after.events.at(-1)).toMatchObject({
      type: "dispatch_failed",
      actor: "system",
      data: { dispatchId: before.dispatch.id, error: "notifier answered 500" },
    });
  });

  it("settles a sent Dispatch as failed once the automatic budget is spent", async () => {
    const before = await sentDispatch();
    await db
      .update(dispatches)
      .set({ autoAttempts: 3 })
      .where(eq(dispatches.id, before.dispatch.id));

    await callback({
      dispatch_id: before.dispatch.id,
      outcome: "failed",
      error: "notifier answered 500",
      n8n_execution_id: "exec-3",
    });

    const after = await snapshot(before.ticket.id);
    expect(after.dispatch.status).toBe("failed");
    expect(after.jobs.map((j) => j.status)).toEqual(["done"]);
  });

  it("settles an Unknown Dispatch when its callback arrives late", async () => {
    const before = await sentDispatch();
    await db
      .update(dispatches)
      .set({ status: "unknown" })
      .where(eq(dispatches.id, before.dispatch.id));

    await callback(succeeded(before.dispatch.id));

    expect((await snapshot(before.ticket.id)).dispatch.status).toBe(
      "succeeded",
    );
  });

  it("records a duplicate callback as an event and changes nothing else", async () => {
    const before = await sentDispatch();
    await callback(succeeded(before.dispatch.id));
    const settled = await snapshot(before.ticket.id);

    const response = await callback({
      dispatch_id: before.dispatch.id,
      outcome: "failed",
      error: "late duplicate",
      n8n_execution_id: "exec-9",
    });

    expect(response.status).toBe(200);
    const after = await snapshot(before.ticket.id);
    expect(after.dispatch).toEqual(settled.dispatch);
    expect(after.attempts).toEqual(settled.attempts);
    expect(after.events.slice(0, -1)).toEqual(settled.events);
    expect(after.events.at(-1)).toMatchObject({
      type: "dispatch_callback_ignored",
      actor: "system",
      data: {
        dispatchId: before.dispatch.id,
        outcome: "failed",
        status: "succeeded",
      },
    });
  });

  it("rejects a bad signature with 401 and changes nothing", async () => {
    const before = await sentDispatch();

    const response = await callback(succeeded(before.dispatch.id), {
      secret: "wrong-secret",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_signature" },
    });
    expect(await snapshot(before.ticket.id)).toEqual(before);
  });

  it("rejects a stale timestamp with 401 and changes nothing", async () => {
    const before = await sentDispatch();

    const response = await callback(succeeded(before.dispatch.id), {
      now: new Date(Date.now() - 6 * 60_000),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "stale_timestamp" },
    });
    expect(await snapshot(before.ticket.id)).toEqual(before);
  });

  it("rejects a callback with the outbound secret: each direction has its own", async () => {
    const before = await sentDispatch();

    const response = await callback(succeeded(before.dispatch.id), {
      secret: "flowdesk-to-n8n",
    });

    expect(response.status).toBe(401);
  });

  it("answers 404 for an unknown dispatch_id", async () => {
    const response = await callback(succeeded(randomUUID()));

    expect(response.status).toBe(404);
  });

  it.each([
    ["non-JSON", "not json"],
    [
      "a bad outcome",
      { dispatch_id: randomUUID(), outcome: "maybe", n8n_execution_id: "e" },
    ],
    ["a missing dispatch_id", { outcome: "succeeded", n8n_execution_id: "e" }],
  ])("answers 422 for %s", async (_name, body) => {
    const response = await callback(body);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });
});
