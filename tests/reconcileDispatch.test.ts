import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepCallbackDeadlines } from "@/services/sweepCallbackDeadlines";
import { createErp } from "../services/erp/erp";
import { createNotifier } from "../services/notifier/notifier";
import { connectTestDb } from "./support/db";
import { ACCESS_REQUEST, dispatchFixtures } from "./support/dispatchFixtures";
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

async function startErp() {
  const server = createErp({ dataFile: join(dir, "incidents.json") });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    createIncident: (key: string) =>
      fetch(`${url}/incidents`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          ticket_number: "FD-0001",
          title: "SAP is down",
          summary: null,
          priority: "urgent",
        }),
      }),
    count: async () =>
      ((await (await fetch(`${url}/`)).text()).match(/<strong>INC-/g) ?? [])
        .length,
  };
}

// Both targets; each test only fills the one its Dispatch goes to.
async function startTargets() {
  const notifier = await startNotifier();
  const erp = await startErp();
  return {
    notifier,
    erp,
    config: { notifierUrl: notifier.url, erpUrl: erp.url },
  };
}

// A Dispatch n8n accepted whose callback never came: swept to `unknown`.
// An access Ticket goes to the notifier unless the ERP Request is asked for.
async function unknownDispatch(request: "access" | "erp" = "access") {
  const ticket = await classifiedTicket(
    request === "access" ? ACCESS_REQUEST : undefined,
  );
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
    const { notifier, config } = await startTargets();
    const { ticketId, dispatchId } = await unknownDispatch();
    await notifier.deliver(dispatchId);

    expect(await runReconcile(ticketId, config)).toBe(true);

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
    const { config } = await startTargets();
    const { ticketId, dispatchId } = await unknownDispatch();

    await runReconcile(ticketId, config);

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
    const { config } = await startTargets();
    const { ticketId, dispatchId } = await unknownDispatch();
    await sql`update dispatches set auto_attempts = 3 where id = ${dispatchId}`;

    await runReconcile(ticketId, config);

    expect((await snapshot(ticketId)).dispatch.status).toBe("failed");
  });

  it("stays unknown and leaves the job to retry when the notifier is unreachable", async () => {
    const { config } = await startTargets();
    const { ticketId } = await unknownDispatch();
    for (const server of servers) await new Promise((r) => server.close(r));
    servers = [];

    await runReconcile(ticketId, config);

    const s = await snapshot(ticketId);
    expect(s.dispatch.status).toBe("unknown");
    expect(s.attempts).toHaveLength(1);
    expect(s.jobs.find((j) => j.kind === "reconcile")).toMatchObject({
      status: "queued",
      lastError: expect.any(String),
    });
  });

  it("does nothing for a Dispatch a late callback already settled", async () => {
    const { config } = await startTargets();
    const { ticketId, dispatchId } = await unknownDispatch();
    await sql`update dispatches set status = 'succeeded' where id = ${dispatchId}`;

    await runReconcile(ticketId, config);

    expect((await snapshot(ticketId)).attempts).toHaveLength(1);
  });
});

describe("reconcile handler for an erp Dispatch", () => {
  it("settles it with the ERP's External Reference, without a second incident", async () => {
    const { erp, config } = await startTargets();
    const { ticketId, dispatchId } = await unknownDispatch("erp");
    // The incident was created but n8n never heard back (the lost response).
    await erp.createIncident(dispatchId);

    expect(await runReconcile(ticketId, config)).toBe(true);

    const s = await snapshot(ticketId);
    expect(s.dispatch.status).toBe("succeeded");
    expect(s.ticket.externalReference).toBe("INC-000001");
    expect(s.events.at(-1)).toMatchObject({
      type: "dispatch_succeeded",
      data: { dispatchId, reconciled: true, externalReference: "INC-000001" },
    });
    expect(
      s.jobs.filter((j) => j.kind === "dispatch" && j.status === "queued"),
    ).toHaveLength(0);
    expect(await erp.count()).toBe(1);
  });

  it("asks the ERP, not the notifier: a notifier delivery does not count", async () => {
    const { notifier, config } = await startTargets();
    const { ticketId, dispatchId } = await unknownDispatch("erp");
    await notifier.deliver(dispatchId);

    await runReconcile(ticketId, config);

    const s = await snapshot(ticketId);
    expect(s.dispatch.status).toBe("pending");
    expect(s.ticket.externalReference).toBeNull();
    expect(s.attempts.at(-1)).toMatchObject({
      trigger: "reconcile",
      outcome: "failed",
      error: "ERP holds no incident for this Dispatch",
    });
  });
});
