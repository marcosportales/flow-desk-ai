import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as postCallback } from "@/app/api/webhooks/n8n/route";
import { FakeClassifier } from "@/infra/classifier/fake";
import { signBody, verifySignature } from "@/infra/crypto/hmac";
import { users } from "@/infra/db/schema";
import { classifyTicket } from "@/services/classifyTicket";
import { integrationActor } from "@/domain/actor";
import { createTicket } from "@/services/createTicket";
import { dispatchTicket } from "@/services/dispatchTicket";
import { runNextJob } from "@/worker/runner";
import { connectTestDb } from "./support/db";
import {
  dispatchConfig,
  dispatchFixtures,
  FROM_N8N_SECRET,
  TO_N8N_SECRET,
} from "./support/dispatchFixtures";
import { type StubRequest, startN8nStub } from "./support/n8nStub";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const { sql, db } = connectTestDb();
const { classifiedTicket, runDispatch, snapshot } = dispatchFixtures(db, sql);

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.N8N_TO_FLOWDESK_SECRET = FROM_N8N_SECRET;
});
afterAll(() => sql.end());

// Does what the n8n workflow does after answering 202: verify, deliver (not
// simulated here), and report back on a signed callback.
async function actLikeN8n(request: StubRequest) {
  const verified = verifySignature({
    secret: TO_N8N_SECRET,
    body: request.body,
    timestamp: request.headers["x-flowdesk-timestamp"] as string,
    signature: request.headers["x-flowdesk-signature"] as string,
  });
  if (!verified.ok) throw new Error(`stub n8n: ${verified.reason}`);
  const event = JSON.parse(request.body);
  const body = JSON.stringify({
    dispatch_id: event.dispatch_id,
    outcome: "succeeded",
    n8n_execution_id: "stub-exec-1",
    delivered_at: new Date().toISOString(),
  });
  const response = await postCallback(
    new Request(event.callback_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signBody(FROM_N8N_SECRET, body),
      },
      body,
    }),
  );
  if (response.status !== 200) {
    throw new Error(`callback answered ${response.status}`);
  }
}

describe("Scenario A: a classified ERP blocker is dispatched and confirmed", () => {
  it("goes pending → classified (urgent) → Dispatch sent → succeeded, with events in order", async () => {
    const stub = await startN8nStub({ onRequest: actLikeN8n });
    const [requester] = await db
      .insert(users)
      .values({
        name: "Scenario A",
        email: `${randomUUID()}@test.example`,
        department: "Finance",
      })
      .returning();
    const created = await createTicket(
      db,
      {
        requesterId: requester!.id,
        idempotencyKey: randomUUID(),
        title: "Cannot process invoices in SAP",
        description:
          "I haven't been able to access SAP since this morning, and I need to process some invoices.",
      },
      integrationActor,
    );
    if (created.kind !== "created") throw new Error("ticket not created");
    const ticketId = created.ticket.id;

    const work = () =>
      runNextJob({
        sql,
        workerId: "scenario-a",
        handlers: {
          classify: (job) =>
            classifyTicket(db, new FakeClassifier("valid"), job),
          dispatch: (job) => dispatchTicket(db, dispatchConfig(stub.url), job),
        },
        ticketIds: [ticketId],
      });
    while (await work());
    await stub.settled();
    await stub.close();

    const s = await snapshot(ticketId);
    expect(s.ticket).toMatchObject({
      classificationState: "classified",
      priority: "urgent",
      priorityRule: "erp_blocker",
      team: "it_systems",
    });
    expect(stub.requests).toHaveLength(1);
    expect(JSON.parse(stub.requests[0]!.body)).toMatchObject({
      dispatch_id: s.dispatch.id,
      team: "it_systems",
      route: "urgent",
    });
    expect(s.dispatch).toMatchObject({
      status: "succeeded",
      route: "urgent",
      autoAttempts: 1,
    });
    expect(s.attempts).toHaveLength(1);
    expect(s.attempts[0]).toMatchObject({
      outcome: "succeeded",
      httpStatus: 202,
      n8nExecutionId: "stub-exec-1",
    });
    expect(s.events.map((e) => [e.type, e.actor])).toEqual([
      ["ticket_created", "integration"],
      ["classification_attempted", "system"],
      ["classified", "system"],
      ["priority_computed", "system"],
      ["dispatch_created", "system"],
      ["dispatch_attempted", "system"],
      ["dispatch_succeeded", "system"],
    ]);
  });

  it("settles the Dispatch even when n8n's callback overtakes its 202", async () => {
    const ticket = await classifiedTicket();
    const stub = await startN8nStub({
      onRequest: actLikeN8n,
      replyAfterMs: 300,
    });

    await runDispatch(ticket.id, stub.url);
    await stub.settled();
    await stub.close();

    const s = await snapshot(ticket.id);
    expect(s.dispatch.status).toBe("succeeded");
    expect(s.attempts.map((a) => a.outcome)).toEqual(["succeeded"]);
    expect(s.events.map((e) => e.type).slice(-2)).toEqual([
      "dispatch_attempted",
      "dispatch_succeeded",
    ]);
  });
});
