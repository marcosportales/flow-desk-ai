import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { verifySignature } from "@/infra/crypto/hmac";
import { jobs, tickets } from "@/infra/db/schema";
import { connectTestDb } from "./support/db";
import { dispatchFixtures, TO_N8N_SECRET } from "./support/dispatchFixtures";
import { startN8nStub } from "./support/n8nStub";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

const { classifiedTicket, runDispatch, snapshot } = dispatchFixtures(db, sql);

describe("dispatchTicket", () => {
  it("POSTs a signed event and marks the Dispatch sent with a callback deadline when n8n answers 202", async () => {
    const ticket = await classifiedTicket();
    const stub = await startN8nStub();
    const before = Date.now();

    expect(await runDispatch(ticket.id, stub.url)).toBe(true);
    await stub.close();

    const s = await snapshot(ticket.id);
    expect(stub.requests).toHaveLength(1);
    const [request] = stub.requests;
    expect(
      verifySignature({
        secret: TO_N8N_SECRET,
        body: request!.body,
        timestamp: request!.headers["x-flowdesk-timestamp"] as string,
        signature: request!.headers["x-flowdesk-signature"] as string,
      }),
    ).toEqual({ ok: true });
    const [row] = await db
      .select({ number: tickets.number })
      .from(tickets)
      .where(eq(tickets.id, ticket.id));
    expect(JSON.parse(request!.body)).toEqual({
      dispatch_id: s.dispatch.id,
      ticket: {
        id: ticket.id,
        number: `FD-${String(row!.number).padStart(4, "0")}`,
        title: "SAP is down",
        summary: expect.any(String),
      },
      category: "erp",
      priority: "urgent",
      team: "it_systems",
      route: "urgent",
      callback_url: "http://app:3000/api/webhooks/n8n",
    });

    expect(s.dispatch).toMatchObject({ status: "sent", autoAttempts: 1 });
    const deadline = s.dispatch.callbackDeadline!.getTime();
    expect(deadline).toBeGreaterThanOrEqual(before + 59_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 61_000);
    expect(s.attempts).toHaveLength(1);
    expect(s.attempts[0]).toMatchObject({
      attemptNo: 1,
      trigger: "auto",
      outcome: "sent",
      httpStatus: 202,
    });
    expect(s.jobs.map((j) => j.status)).toEqual(["done"]);
    expect(s.events.at(-1)).toMatchObject({
      type: "dispatch_attempted",
      actor: "system",
      data: { dispatchId: s.dispatch.id, attemptNo: 1, outcome: "sent" },
    });
  });

  it("records a failed attempt on a non-2xx answer and leaves the job to retry", async () => {
    const ticket = await classifiedTicket();
    const stub = await startN8nStub({ respond: () => 500 });

    await runDispatch(ticket.id, stub.url);
    await stub.close();

    const s = await snapshot(ticket.id);
    expect(s.dispatch).toMatchObject({ status: "pending", autoAttempts: 1 });
    expect(s.attempts).toHaveLength(1);
    expect(s.attempts[0]).toMatchObject({
      outcome: "failed",
      httpStatus: 500,
      error: expect.stringContaining("500"),
    });
    expect(s.jobs).toHaveLength(1);
    expect(s.jobs[0]).toMatchObject({ status: "queued" });
  });

  it("records a failed attempt when n8n is unreachable", async () => {
    const ticket = await classifiedTicket();
    const stub = await startN8nStub();
    await stub.close();

    await runDispatch(ticket.id, stub.url);

    const s = await snapshot(ticket.id);
    expect(s.attempts).toHaveLength(1);
    expect(s.attempts[0]).toMatchObject({
      outcome: "failed",
      httpStatus: null,
      error: expect.any(String),
    });
    expect(s.dispatch.status).toBe("pending");
  });

  it("fails the Dispatch once three automatic attempts have failed", async () => {
    const ticket = await classifiedTicket();
    const stub = await startN8nStub({ respond: () => 503 });

    for (let i = 0; i < 3; i++) await runDispatch(ticket.id, stub.url);
    // Nothing left to run.
    expect(await runDispatch(ticket.id, stub.url)).toBe(false);
    await stub.close();

    const s = await snapshot(ticket.id);
    expect(stub.requests).toHaveLength(3);
    expect(s.dispatch).toMatchObject({ status: "failed", autoAttempts: 3 });
    expect(s.attempts.map((a) => [a.attemptNo, a.outcome])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "failed"],
    ]);
    expect(s.jobs.map((j) => j.status)).toEqual(["done"]);
    expect(s.events.map((e) => e.type).slice(-4)).toEqual([
      "dispatch_attempted",
      "dispatch_attempted",
      "dispatch_attempted",
      "dispatch_failed",
    ]);
  });

  it("does nothing for a Dispatch that is no longer pending", async () => {
    const ticket = await classifiedTicket();
    const stub = await startN8nStub();
    await runDispatch(ticket.id, stub.url);
    const { dispatch } = await snapshot(ticket.id);

    // A second job for the same Dispatch, e.g. after a lease was reclaimed.
    await db.insert(jobs).values({
      kind: "dispatch",
      ticketId: ticket.id,
      dispatchId: dispatch.id,
    });
    await runDispatch(ticket.id, stub.url);
    await stub.close();

    expect(stub.requests).toHaveLength(1);
    expect((await snapshot(ticket.id)).attempts).toHaveLength(1);
  });
});
