import { afterAll, describe, expect, it } from "vitest";
import { sweepCallbackDeadlines } from "@/services/sweepCallbackDeadlines";
import { connectTestDb } from "./support/db";
import { dispatchFixtures } from "./support/dispatchFixtures";
import { startN8nStub } from "./support/n8nStub";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

const { classifiedTicket, runDispatch, snapshot } = dispatchFixtures(db, sql);

async function sentDispatch(deadlineOffsetSeconds: number) {
  const ticket = await classifiedTicket();
  const stub = await startN8nStub();
  await runDispatch(ticket.id, stub.url);
  await stub.close();
  const { dispatch } = await snapshot(ticket.id);
  await sql`update dispatches
    set callback_deadline = now() + ${`${deadlineOffsetSeconds} seconds`}::interval
    where id = ${dispatch.id}`;
  return ticket.id;
}

describe("sweepCallbackDeadlines", () => {
  it("marks a sent Dispatch past its deadline unknown and enqueues one reconcile job", async () => {
    const ticketId = await sentDispatch(-1);

    await sweepCallbackDeadlines(db);
    await sweepCallbackDeadlines(db);

    const s = await snapshot(ticketId);
    expect(s.dispatch.status).toBe("unknown");
    expect(s.attempts.at(-1)).toMatchObject({ outcome: "unknown" });
    expect(
      s.jobs.filter((j) => j.kind === "reconcile").map((j) => j.status),
    ).toEqual(["queued"]);
    expect(s.events.at(-1)).toMatchObject({
      type: "dispatch_unknown",
      actor: "system",
      data: { dispatchId: s.dispatch.id },
    });
  });

  it("leaves a sent Dispatch alone until its deadline passes", async () => {
    const ticketId = await sentDispatch(30);

    await sweepCallbackDeadlines(db);

    const s = await snapshot(ticketId);
    expect(s.dispatch.status).toBe("sent");
    expect(s.jobs.filter((j) => j.kind === "reconcile")).toHaveLength(0);
  });
});
