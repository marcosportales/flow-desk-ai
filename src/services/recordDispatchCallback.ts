import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { transitionDispatchStatus } from "@/domain/transitions";
import {
  dispatchAttempts,
  dispatches,
  ticketEvents,
  tickets,
} from "@/infra/db/schema";
import type { Db } from "./createTicket";
import { failDispatch } from "./failDispatch";

// n8n's report on a Dispatch: docs/plan/IMPLEMENTATION.md §4.5.

export const DispatchCallback = z.object({
  dispatch_id: z.uuid(),
  outcome: z.enum(["succeeded", "failed"]),
  error: z.string().nullish(),
  n8n_execution_id: z.string().min(1),
  delivered_at: z.string().nullish(),
  // The record id a target system gave back, e.g. an ERP incident number.
  external_reference: z.string().trim().min(1).max(200).nullish(),
});
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
      await tx.insert(ticketEvents).values({
        ticketId: dispatch.ticketId,
        type: "dispatch_callback_ignored",
        actor: "system",
        data: {
          dispatchId: dispatch.id,
          outcome: callback.outcome,
          status: dispatch.status,
          n8nExecutionId: callback.n8n_execution_id,
        },
      });
      return { kind: "ignored" };
    }

    if (callback.outcome === "failed") {
      await failDispatch(tx, dispatch);
    } else {
      transitionDispatchStatus(dispatch.status, "succeeded");
      await tx
        .update(dispatches)
        .set({ status: "succeeded" })
        .where(eq(dispatches.id, dispatch.id));
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
          n8nExecutionId: callback.n8n_execution_id,
          error: callback.error ?? null,
          finishedAt: new Date(),
        })
        .where(eq(dispatchAttempts.id, attempt.id));
    }
    await tx.insert(ticketEvents).values({
      ticketId: dispatch.ticketId,
      type:
        callback.outcome === "succeeded"
          ? "dispatch_succeeded"
          : "dispatch_failed",
      actor: "system",
      data: {
        dispatchId: dispatch.id,
        n8nExecutionId: callback.n8n_execution_id,
        deliveredAt: callback.delivered_at ?? null,
        error: callback.error ?? null,
        ...(callback.outcome === "succeeded" && callback.external_reference
          ? { externalReference: callback.external_reference }
          : {}),
      },
    });
    return { kind: "settled" };
  });
}
