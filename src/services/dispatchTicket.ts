import { eq, max, sql } from "drizzle-orm";
import { formatTicketNumber } from "@/domain/ticketNumber";
import { transitionDispatchStatus } from "@/domain/transitions";
import { signBody } from "@/infra/crypto/hmac";
import {
  dispatchAttempts,
  dispatches,
  ticketEvents,
  tickets,
} from "@/infra/db/schema";
import type { Db } from "./createTicket";

// Dispatch handler: docs/plan/IMPLEMENTATION.md §4.4, ADR 0005, ADR 0006.
// The app has already decided Category, Priority, Team and Route; n8n only
// executes and reports back on the callback webhook.

export const MAX_AUTO_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export type DispatchConfig = {
  webhookUrl: string;
  secret: string;
  callbackUrl: string;
  callbackTimeoutSeconds: number;
};

type DispatchJob = { dispatchId: string | null };

type PostResult =
  | { ok: true; httpStatus: number }
  | { ok: false; httpStatus: number | null; error: string };

async function post(
  url: string,
  secret: string,
  body: string,
): Promise<PostResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signBody(secret, body),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok
      ? { ok: true, httpStatus: response.status }
      : {
          ok: false,
          httpStatus: response.status,
          error: `n8n answered HTTP ${response.status}`,
        };
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    return {
      ok: false,
      httpStatus: null,
      error: [(error as Error).message, cause].filter(Boolean).join(": "),
    };
  }
}

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
  const retry = await db.transaction(async (tx) => {
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

    const body = JSON.stringify({
      dispatch_id: dispatch.id,
      ticket: {
        id: ticket!.id,
        number: formatTicketNumber(ticket!.number),
        title: ticket!.title,
        summary: ticket!.summary,
      },
      category: dispatch.category,
      priority: dispatch.priority,
      team: dispatch.team,
      route: dispatch.route,
      callback_url: config.callbackUrl,
    });
    const startedAt = new Date();
    const result = await post(config.webhookUrl, config.secret, body);
    const outcome = result.ok ? "sent" : "failed";

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
      trigger: "auto",
      outcome,
      httpStatus: result.httpStatus,
      error: result.ok ? null : result.error,
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
        httpStatus: result.httpStatus,
        error: result.ok ? null : result.error,
      },
    });

    const autoAttempts = dispatch.autoAttempts + 1;
    const exhausted = !result.ok && autoAttempts >= MAX_AUTO_ATTEMPTS;
    const status = result.ok ? "sent" : exhausted ? "failed" : "pending";
    if (status !== "pending") transitionDispatchStatus("pending", status);
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
          reason: `n8n did not accept the Dispatch after ${autoAttempts} attempts: ${result.error}`,
        },
      });
    }
    return !result.ok && !exhausted;
  });

  // Committed above; the throw only makes the worker re-run the job with
  // backoff while the automatic budget lasts.
  if (retry) throw new Error(`Dispatch ${dispatchId} not accepted by n8n`);
}
