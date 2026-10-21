import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { systemActor } from "@/domain/actor";
import { dispatchAttempts, dispatches, tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";
import { failDispatch } from "./failDispatch";
import { appendTicketEvent, moveDispatchStatus } from "./ticketWrites";

// The Workflow Engine's report on a Dispatch: docs/plan/IMPLEMENTATION.md §4.5.

const DispatchCallbackBody = z.object({
  dispatch_id: z.uuid(),
  outcome: z.enum(["succeeded", "failed"]),
  error: z.string().nullish(),
  execution_reference: z.string().min(1),
  delivered_at: z.string().nullish(),
  // The record id a target system gave back, e.g. an ERP incident number.
  external_reference: z.string().trim().min(1).max(200).nullish(),
});

// n8n workflows not yet updated still send `n8n_execution_id`, the
// Execution Reference's old name.
export const DispatchCallback = z.preprocess(
  (body) =>
    body &&
    typeof body === "object" &&
    "n8n_execution_id" in body &&
    !("execution_reference" in body)
      ? { ...body, execution_reference: body.n8n_execution_id }
      : body,
  DispatchCallbackBody,
);
export type DispatchCallback = z.infer<typeof DispatchCallback>;

export type CallbackResult =
  { kind: "settled" } | { kind: "ignored" } | { kind: "not_found" };

export async function recordDispatchCallback(
  db: Db,
  callback: DispatchCallback,
): Promise<CallbackResult> {
  return db.transaction(async (tx) => {
    // Waits for a dispatch handler still holding the row (see dispatchTicket).
    const [dispatch] = await tx
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, callback.dispatch_id))
      .for("update");
    if (!dispatch) return { kind: "not_found" };

    // Duplicates, and callbacks for a Dispatch already settled another way,
    // are kept for the timeline but change nothing.
    if (dispatch.status !== "sent" && dispatch.status !== "unknown") {
      await appendTicketEvent(tx, dispatch.ticketId, systemActor, {
        type: "dispatch_callback_ignored",
        data: {
          dispatchId: dispatch.id,
          outcome: callback.outcome,
          status: dispatch.status,
          executionReference: callback.execution_reference,
        },
      });
      return { kind: "ignored" };
    }

    const reported = {
      dispatchId: dispatch.id,
      executionReference: callback.execution_reference,
      deliveredAt: callback.delivered_at ?? null,
      error: callback.error ?? null,
    };
    if (callback.outcome === "failed") {
      await failDispatch(tx, dispatch, reported);
    } else {
      await moveDispatchStatus(tx, dispatch, "succeeded", {
        actor: systemActor,
        event: {
          type: "dispatch_succeeded",
          data: callback.external_reference
            ? { ...reported, externalReference: callback.external_reference }
            : reported,
        },
      });
      if (callback.external_reference) {
        await tx
          .update(tickets)
          .set({ externalReference: callback.external_reference })
          .where(eq(tickets.id, dispatch.ticketId));
      }
    }
    // The callback reports on the attempt that is in flight, the latest one.
    const [attempt] = await tx
      .select({ id: dispatchAttempts.id })
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.dispatchId, dispatch.id))
      .orderBy(desc(dispatchAttempts.attemptNo))
      .limit(1);
    if (attempt) {
      await tx
        .update(dispatchAttempts)
        .set({
          outcome: callback.outcome,
          executionReference: callback.execution_reference,
          error: callback.error ?? null,
          finishedAt: new Date(),
        })
        .where(eq(dispatchAttempts.id, attempt.id));
    }
    return { kind: "settled" };
  });
}
