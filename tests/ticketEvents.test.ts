import { afterAll, describe, expect, it } from "vitest";
import { TicketEvent } from "@/domain/ticketEvents";
import type { NewTicketEvent } from "@/infra/db/schema";
import { recordDispatchCallback } from "@/services/recordDispatchCallback";
import { connectTestDb } from "./support/db";
import { dispatchFixtures } from "./support/dispatchFixtures";
import { startN8nStub } from "./support/n8nStub";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

const { classifiedTicket, runDispatch, snapshot } = dispatchFixtures(db, sql);

const ticketId = "00000000-0000-0000-0000-000000000001";
const dispatchId = "00000000-0000-0000-0000-000000000002";

// Checked by `pnpm typecheck`: each `@ts-expect-error` fails the build if the
// line below it ever compiles.
describe("Ticket Event types", () => {
  it("accept an event whose data has its type's shape", () => {
    const event: NewTicketEvent = {
      ticketId,
      type: "dispatch_unknown",
      actor: "system",
      data: { dispatchId },
    };
    expect(event.type).toBe("dispatch_unknown");
  });

  it("reject an unknown type", () => {
    const event: NewTicketEvent = {
      ticketId,
      // @ts-expect-error not a Ticket Event type
      type: "ticket_exploded",
      actor: "system",
      data: { dispatchId },
    };
    expect(event).toBeDefined();
  });

  it("reject data shaped for another type", () => {
    const event: NewTicketEvent = {
      ticketId,
      type: "ticket_created",
      actor: "system",
      // @ts-expect-error `dispatch_unknown` data, not `ticket_created`
      data: { dispatchId },
    };
    expect(event).toBeDefined();
  });

  it("reject data missing a field its type requires", () => {
    // @ts-expect-error `status_changed` needs `to`
    const event: NewTicketEvent = {
      ticketId,
      type: "status_changed",
      actor: "system",
      data: { from: "open" },
    };
    expect(event).toBeDefined();
  });
});

describe("Ticket Event schema", () => {
  it("parses every event a Ticket gets from creation to a delivered Dispatch", async () => {
    const ticket = await classifiedTicket();
    const stub = await startN8nStub();
    await runDispatch(ticket.id, stub.url);
    await stub.close();
    const { dispatch } = await snapshot(ticket.id);
    await recordDispatchCallback(db, {
      dispatch_id: dispatch.id,
      outcome: "succeeded",
      n8n_execution_id: "exec-1",
      external_reference: "INC-000042",
    });

    const { events } = await snapshot(ticket.id);
    expect(events.map((e) => e.type)).toEqual([
      "ticket_created",
      "classification_attempted",
      "classified",
      "priority_computed",
      "dispatch_created",
      "dispatch_attempted",
      "dispatch_succeeded",
    ]);
    for (const { type, data } of events) {
      expect(TicketEvent.safeParse({ type, data }).error).toBeUndefined();
    }
  });

  it("rejects data shaped for another type", () => {
    const parsed = TicketEvent.safeParse({
      type: "ticket_created",
      data: { dispatchId: "00000000-0000-0000-0000-000000000002" },
    });
    expect(parsed.success).toBe(false);
  });
});
