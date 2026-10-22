import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as postN8nCallback } from "@/app/api/webhooks/n8n/route";
import { POST as postCallback } from "@/app/api/webhooks/power-automate/route";
import { signBody } from "@/infra/crypto/hmac";
import { connectTestDb } from "./support/db";
import {
  dispatchFixtures,
  FROM_N8N_SECRET,
  FROM_POWER_AUTOMATE_SECRET,
  powerAutomateDispatchConfig,
} from "./support/dispatchFixtures";
import { startN8nStub } from "./support/n8nStub";
import { startPowerAutomateStub } from "./support/powerAutomateStub";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const { sql, db } = connectTestDb();
beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.N8N_TO_FLOWDESK_SECRET = FROM_N8N_SECRET;
  process.env.POWER_AUTOMATE_TO_FLOWDESK_SECRET = FROM_POWER_AUTOMATE_SECRET;
});
afterAll(() => sql.end());

const { classifiedTicket, runDispatch, snapshot } = dispatchFixtures(db, sql);

function callback(
  body: unknown,
  authorization: string | null = `Bearer ${FROM_POWER_AUTOMATE_SECRET}`,
) {
  return postCallback(
    new Request("http://localhost/api/webhooks/power-automate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === null ? {} : { authorization }),
      },
      body: JSON.stringify(body),
    }),
  );
}

// Power Automate's run name, `workflow()['run']['name']`.
const RUN_NAME = "08584629018413470432857123488CU12";

const succeeded = (dispatchId: string) => ({
  dispatch_id: dispatchId,
  outcome: "succeeded",
  execution_reference: RUN_NAME,
  delivered_at: "2026-10-22T12:00:01.000Z",
});

// A Ticket whose Dispatch Power Automate has accepted (`sent`).
async function sentToPowerAutomate() {
  const ticket = await classifiedTicket();
  const stub = await startPowerAutomateStub();
  await runDispatch(ticket.id, powerAutomateDispatchConfig(stub.url));
  await stub.close();
  return snapshot(ticket.id);
}

describe("dispatching to Power Automate", () => {
  it("POSTs the same event to the trigger URL, calling back on the Power Automate route", async () => {
    const ticket = await classifiedTicket();
    const stub = await startPowerAutomateStub();

    await runDispatch(ticket.id, powerAutomateDispatchConfig(stub.url));
    await stub.close();

    const s = await snapshot(ticket.id);
    expect(stub.requests).toHaveLength(1);
    const [request] = stub.requests;
    // No HMAC: the trigger URL's `sig` authenticates the call (ADR 0011).
    expect(request!.headers["x-flowdesk-signature"]).toBeUndefined();
    expect(request!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request!.body)).toMatchObject({
      dispatch_id: s.dispatch.id,
      ticket: { id: ticket.id, title: "SAP is down" },
      category: "erp",
      priority: "urgent",
      team: "it_systems",
      route: "urgent",
      callback_url: "http://app:3000/api/webhooks/power-automate",
    });
    expect(s.dispatch).toMatchObject({ status: "sent", autoAttempts: 1 });
    expect(s.attempts).toHaveLength(1);
    expect(s.attempts[0]).toMatchObject({
      outcome: "sent",
      httpStatus: 202,
      workflowEngine: "power_automate",
    });
    expect(s.events.at(-1)).toMatchObject({
      type: "dispatch_attempted",
      data: { outcome: "sent", workflowEngine: "power_automate" },
    });
  });

  it("records a failed attempt, naming Power Automate, on a non-2xx answer", async () => {
    const ticket = await classifiedTicket();
    const stub = await startPowerAutomateStub({ respond: () => 502 });

    await runDispatch(ticket.id, powerAutomateDispatchConfig(stub.url));
    await stub.close();

    const s = await snapshot(ticket.id);
    expect(s.dispatch).toMatchObject({ status: "pending", autoAttempts: 1 });
    expect(s.attempts[0]).toMatchObject({
      outcome: "failed",
      httpStatus: 502,
      workflowEngine: "power_automate",
      error: "Power Automate answered HTTP 502",
    });
  });

  it("sends a retry to the engine configured at the time of the attempt", async () => {
    const ticket = await classifiedTicket();
    const n8n = await startN8nStub({ respond: () => 500 });
    await runDispatch(ticket.id, n8n.url);
    await n8n.close();

    // The deployment switches engines before the automatic retry runs.
    const powerAutomate = await startPowerAutomateStub();
    await runDispatch(
      ticket.id,
      powerAutomateDispatchConfig(powerAutomate.url),
    );
    await powerAutomate.close();

    const s = await snapshot(ticket.id);
    expect(powerAutomate.requests).toHaveLength(1);
    expect(s.dispatch).toMatchObject({ status: "sent", autoAttempts: 2 });
    expect(
      s.attempts.map((a) => [a.workflowEngine, a.outcome, a.httpStatus]),
    ).toEqual([
      ["n8n", "failed", 500],
      ["power_automate", "sent", 202],
    ]);
  });

  it("records n8n on an attempt n8n ran", async () => {
    const ticket = await classifiedTicket();
    const stub = await startN8nStub();

    await runDispatch(ticket.id, stub.url);
    await stub.close();

    const s = await snapshot(ticket.id);
    expect(s.attempts[0]).toMatchObject({ workflowEngine: "n8n" });
    expect(s.events.at(-1)).toMatchObject({
      type: "dispatch_attempted",
      data: { workflowEngine: "n8n" },
    });
  });
});

describe("POST /api/webhooks/power-automate", () => {
  it("settles a Dispatch sent to Power Automate from its callback", async () => {
    const before = await sentToPowerAutomate();

    const response = await callback(succeeded(before.dispatch.id));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "settled" });
    const after = await snapshot(before.ticket.id);
    expect(after.dispatch.status).toBe("succeeded");
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]).toMatchObject({
      outcome: "succeeded",
      workflowEngine: "power_automate",
      executionReference: RUN_NAME,
    });
    expect(after.events.at(-1)).toMatchObject({
      type: "dispatch_succeeded",
      data: { dispatchId: before.dispatch.id, executionReference: RUN_NAME },
    });
  });

  it.each([
    ["no bearer", null],
    ["a wrong bearer", "Bearer not-the-secret"],
    ["the secret without the Bearer scheme", FROM_POWER_AUTOMATE_SECRET],
  ])(
    "rejects a callback with %s with 401 and changes nothing",
    async (_, authorization) => {
      const before = await sentToPowerAutomate();

      const response = await callback(
        succeeded(before.dispatch.id),
        authorization,
      );

      expect(response.status).toBe(401);
      expect(await snapshot(before.ticket.id)).toEqual(before);
    },
  );

  it("rejects every callback with 401 when its secret is not set, as on an n8n deployment", async () => {
    const before = await sentToPowerAutomate();
    delete process.env.POWER_AUTOMATE_TO_FLOWDESK_SECRET;
    try {
      const response = await callback(succeeded(before.dispatch.id));

      expect(response.status).toBe(401);
      expect(await snapshot(before.ticket.id)).toEqual(before);
    } finally {
      process.env.POWER_AUTOMATE_TO_FLOWDESK_SECRET =
        FROM_POWER_AUTOMATE_SECRET;
    }
  });

  it("rejects an invalid callback with 422", async () => {
    const before = await sentToPowerAutomate();

    const response = await callback({ dispatch_id: before.dispatch.id });

    expect(response.status).toBe(422);
    expect(await snapshot(before.ticket.id)).toEqual(before);
  });

  it("answers 404 for an unknown dispatch_id", async () => {
    const response = await callback(succeeded(crypto.randomUUID()));

    expect(response.status).toBe(404);
  });

  it("still settles a Dispatch sent to n8n before the switch from n8n's callback", async () => {
    const ticket = await classifiedTicket();
    const n8n = await startN8nStub();
    await runDispatch(ticket.id, n8n.url);
    await n8n.close();
    const before = await snapshot(ticket.id);

    const body = JSON.stringify({
      ...succeeded(before.dispatch.id),
      execution_reference: "n8n-exec-7",
    });
    const response = await postN8nCallback(
      new Request("http://localhost/api/webhooks/n8n", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signBody(FROM_N8N_SECRET, body),
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    const after = await snapshot(ticket.id);
    expect(after.dispatch.status).toBe("succeeded");
    expect(after.attempts[0]).toMatchObject({
      workflowEngine: "n8n",
      executionReference: "n8n-exec-7",
    });
  });
});
