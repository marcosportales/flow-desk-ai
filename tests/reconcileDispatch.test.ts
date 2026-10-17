import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepCallbackDeadlines } from "@/services/sweepCallbackDeadlines";
import { createNotifier } from "../services/notifier/notifier";
import { connectTestDb } from "./support/db";
import { dispatchFixtures } from "./support/dispatchFixtures";
import { startN8nStub } from "./support/n8nStub";

const { sql, db } = connectTestDb();
const { classifiedTicket, runDispatch, runReconcile, snapshot } =
  dispatchFixtures(db, sql);

let dir: string;
let servers: Server[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reconcile-"));
});
afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  servers = [];
  await rm(dir, { recursive: true, force: true });
});
afterAll(() => sql.end());

async function startNotifier() {
  const server = createNotifier({ dataFile: join(dir, "deliveries.json") });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    deliver: (key: string) =>
      fetch(`${url}/deliveries`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          channel: "#it-systems",
          message: "ERP is down",
        }),
      }),
  };
}

// A Dispatch n8n accepted whose callback never came: swept to `unknown`.
async function unknownDispatch() {
  const ticket = await classifiedTicket();
  const stub = await startN8nStub();
  await runDispatch(ticket.id, stub.url);
  await stub.close();
  const { dispatch } = await snapshot(ticket.id);
  await sql`update dispatches set callback_deadline = now() - interval '1 second'
    where id = ${dispatch.id}`;
  await sweepCallbackDeadlines(db);
  return { ticketId: ticket.id, dispatchId: dispatch.id };
}

describe("reconcile handler", () => {
  it("settles the Dispatch as succeeded when the notifier holds the delivery", async () => {
    const notifier = await startNotifier();
    const { ticketId, dispatchId } = await unknownDispatch();
    await notifier.deliver(dispatchId);

    expect(await runReconcile(ticketId, notifier.url)).toBe(true);

    const s = await snapshot(ticketId);
    expect(s.dispatch.status).toBe("succeeded");
    expect(s.attempts.at(-1)).toMatchObject({
      attemptNo: 2,
      trigger: "reconcile",
      outcome: "succeeded",
    });
    expect(s.attempts[0]).toMatchObject({ outcome: "unknown" });
    expect(s.events.at(-1)).toMatchObject({
      type: "dispatch_succeeded",
      actor: "system",
      data: { dispatchId, reconciled: true },
    });
    expect(s.jobs.map((j) => j.status)).toEqual(["done", "done"]);
  });

  it("fails the Dispatch and queues an automatic retry when the notifier has no delivery", async () => {
    const notifier = await startNotifier();
    const { ticketId, dispatchId } = await unknownDispatch();

    await runReconcile(ticketId, notifier.url);

    const s = await snapshot(ticketId);
    expect(s.dispatch).toMatchObject({ id: dispatchId, status: "pending" });
    expect(s.attempts.at(-1)).toMatchObject({
      trigger: "reconcile",
      outcome: "failed",
    });
    expect(
      s.jobs.filter((j) => j.kind === "dispatch" && j.status === "queued"),
    ).toHaveLength(1);
  });

  it("leaves the Dispatch failed for a manual retry when the automatic budget is spent", async () => {
    const notifier = await startNotifier();
    const { ticketId, dispatchId } = await unknownDispatch();
    await sql`update dispatches set auto_attempts = 3 where id = ${dispatchId}`;

    await runReconcile(ticketId, notifier.url);

    expect((await snapshot(ticketId)).dispatch.status).toBe("failed");
  });

  it("stays unknown and leaves the job to retry when the notifier is unreachable", async () => {
    const notifier = await startNotifier();
    const { ticketId } = await unknownDispatch();
    const url = notifier.url;
    for (const server of servers) await new Promise((r) => server.close(r));
    servers = [];

    await runReconcile(ticketId, url);

    const s = await snapshot(ticketId);
    expect(s.dispatch.status).toBe("unknown");
    expect(s.attempts).toHaveLength(1);
    expect(s.jobs.find((j) => j.kind === "reconcile")).toMatchObject({
      status: "queued",
      lastError: expect.any(String),
    });
  });

  it("does nothing for a Dispatch a late callback already settled", async () => {
    const notifier = await startNotifier();
    const { ticketId, dispatchId } = await unknownDispatch();
    await sql`update dispatches set status = 'succeeded' where id = ${dispatchId}`;

    await runReconcile(ticketId, notifier.url);

    expect((await snapshot(ticketId)).attempts).toHaveLength(1);
  });
});
