import { and, desc, eq, lt } from "drizzle-orm";
import { transitionDispatchStatus } from "@/domain/transitions";
import {
  dispatchAttempts,
  dispatches,
  jobs,
  type NewTicketEvent,
  ticketEvents,
} from "@/infra/db/schema";
import type { Db } from "./createTicket";

// Deadline sweep: docs/plan/IMPLEMENTATION.md §2.5. A `sent` Dispatch with no
// callback by its deadline becomes `unknown` and is reconciled (ADR 0006).

// More tries than a normal job: with the 5-minute backoff cap this outlasts a
// notifier outage of over an hour, so a Dispatch is not left `unknown` for good.
export const RECONCILE_MAX_ATTEMPTS = 20;

export async function sweepCallbackDeadlines(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    // Skips rows a callback is settling right now; the next sweep sees them.
    const overdue = await tx
      .select()
      .from(dispatches)
      .where(
        and(
          eq(dispatches.status, "sent"),
          lt(dispatches.callbackDeadline, new Date()),
        ),
      )
      .for("update", { skipLocked: true });

    for (const dispatch of overdue) {
      transitionDispatchStatus(dispatch.status, "unknown");
      await tx
        .update(dispatches)
        .set({ status: "unknown" })
        .where(eq(dispatches.id, dispatch.id));
      const [attempt] = await tx
        .select({ id: dispatchAttempts.id })
        .from(dispatchAttempts)
        .where(eq(dispatchAttempts.dispatchId, dispatch.id))
        .orderBy(desc(dispatchAttempts.attemptNo))
        .limit(1);
      if (attempt) {
        await tx
          .update(dispatchAttempts)
          .set({ outcome: "unknown", finishedAt: new Date() })
          .where(eq(dispatchAttempts.id, attempt.id));
      }
      await tx.insert(ticketEvents).values({
        ticketId: dispatch.ticketId,
        type: "dispatch_unknown",
        actor: "system",
        data: { dispatchId: dispatch.id },
      } satisfies NewTicketEvent);
      await tx.insert(jobs).values({
        kind: "reconcile",
        ticketId: dispatch.ticketId,
        dispatchId: dispatch.id,
        maxAttempts: RECONCILE_MAX_ATTEMPTS,
      });
    }
    return overdue.length;
  });
}
