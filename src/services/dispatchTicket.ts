import { eq, max, sql } from "drizzle-orm";
import { formatTicketNumber } from "@/domain/ticketNumber";
import { transitionDispatchStatus } from "@/domain/transitions";
import {
  dispatchAttempts,
  dispatches,
  ticketEvents,
  tickets,
} from "@/infra/db/schema";
import type { DispatchConfig } from "@/infra/n8n/config";
import { sendDispatchEvent } from "@/infra/n8n/client";
import type { Db } from "./createTicket";

// Dispatch handler: docs/plan/IMPLEMENTATION.md §4.4, ADR 0005, ADR 0006.
// The app has already decided Category, Priority, Team and Route; n8n only
// executes and reports back on the callback webhook.

export const MAX_AUTO_ATTEMPTS = 3;

type DispatchJob = { dispatchId: string | null };

export async function dispatchTicket(
  db: Db,
  config: DispatchConfig,
  job: DispatchJob,
): Promise<void> {
  if (!job.dispatchId) throw new Error("dispatch job without a dispatch_id");
  const dispatchId = job.dispatchId;

  // The row lock is held across the POST: n8n answers 202 and may call back
  // before this commits, and the callback's own lock then waits for `sent`
  // instead of finding the Dispatch still `pending`. It also stops a second
  // worker (after a reclaimed lease) from sending the same Dispatch twice.
  const leaveJobToRetry = await db.transaction(async (tx) => {
    const [dispatch] = await tx
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, dispatchId))
      .for("update");
    if (!dispatch) throw new Error(`Dispatch ${dispatchId} not found`);
    if (dispatch.status !== "pending") return false;
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, dispatch.ticketId));
    if (!ticket) throw new Error(`Ticket ${dispatch.ticketId} not found`);

    // Only a manual retry (§4.7) reaches the handler with the automatic budget
    // already spent; automatic retries and Reconciliation follow-ups never do.
    const manual = dispatch.autoAttempts >= MAX_AUTO_ATTEMPTS;
    const body = JSON.stringify({
      dispatch_id: dispatch.id,
      ticket: {
        id: ticket.id,
        number: formatTicketNumber(ticket.number),
        title: ticket.title,
        summary: ticket.summary,
      },
      category: dispatch.category,
      priority: dispatch.priority,
      team: dispatch.team,
      route: dispatch.route,
      callback_url: config.callbackUrl,
    });
    const startedAt = new Date();
    const result = await sendDispatchEvent(config, body);
    const outcome = result.ok ? "sent" : "failed";
    const failure = {
      httpStatus: result.httpStatus,
      error: result.ok ? null : result.error,
    };

    const [{ last }] = (await tx
      .select({ last: max(dispatchAttempts.attemptNo) })
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.dispatchId, dispatch.id))) as [
      { last: number | null },
    ];
    const attemptNo = (last ?? 0) + 1;
    await tx.insert(dispatchAttempts).values({
      dispatchId: dispatch.id,
      attemptNo,
      trigger: manual ? "manual" : "auto",
      outcome,
      ...failure,
      startedAt,
      finishedAt: new Date(),
    });
    await tx.insert(ticketEvents).values({
      ticketId: dispatch.ticketId,
      type: "dispatch_attempted",
      actor: "system",
      data: {
        dispatchId: dispatch.id,
        attemptNo,
        outcome,
        ...failure,
      },
    });

    // A manual attempt is a single try: it does not spend the automatic budget
    // and, if it fails, goes straight back to `failed`.
    const autoAttempts = manual
      ? dispatch.autoAttempts
      : dispatch.autoAttempts + 1;
    const exhausted =
      !result.ok && (manual || autoAttempts >= MAX_AUTO_ATTEMPTS);
    const status = result.ok ? "sent" : exhausted ? "failed" : "pending";
    if (status !== dispatch.status) {
      transitionDispatchStatus(dispatch.status, status);
    }
    await tx
      .update(dispatches)
      .set({
        status,
        autoAttempts,
        callbackDeadline: result.ok
          ? sql`now() + ${`${config.callbackTimeoutSeconds} seconds`}::interval`
          : null,
      })
      .where(eq(dispatches.id, dispatch.id));
    if (exhausted) {
      await tx.insert(ticketEvents).values({
        ticketId: dispatch.ticketId,
        type: "dispatch_failed",
        actor: "system",
        data: {
          dispatchId: dispatch.id,
          reason: manual
            ? `n8n did not accept the manual retry: ${result.error}`
            : `n8n did not accept the Dispatch after ${autoAttempts} attempts: ${result.error}`,
        },
      });
    }
    return !result.ok && !exhausted;
  });

  // Committed above; the throw only makes the worker re-run the job with
  // backoff while the automatic budget lasts.
  if (leaveJobToRetry)
    throw new Error(`Dispatch ${dispatchId} not accepted by n8n`);
}
