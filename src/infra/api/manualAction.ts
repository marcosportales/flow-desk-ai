import { z } from "zod";
import { getDb } from "@/infra/db/client";
import type { Db } from "@/services/createTicket";
import { type Actor, userActor } from "@/domain/actor";
import { getRequestUser } from "@/infra/auth/session";
import {
  authorizeManualAction,
  type ManualActionAuthorization,
} from "@/services/authorizeManualAction";
import { errorResponse } from "./errors";

// Shared plumbing for the manual Ticket actions (IMPLEMENTATION.md §4.7, §7):
// Operator session, id and JSON body checks, then the service result as a
// response.

// Manual Actions need an Operator session (ADR 0008): no session is 401, and
// an Integration's API key never substitutes for one (403). Resolves to the
// Operator as the event actor when the caller may proceed.
export async function rejectUnlessOperator(
  request: Request,
  db: Db,
  target: { ticketId: string } | { dispatchId: string },
): Promise<{ response: Response } | { actor: Actor }> {
  const user = await getRequestUser(request);
  if (!user) {
    return {
      response: request.headers.get("x-api-key")
        ? errorResponse(
            403,
            "forbidden",
            "Manual Actions require an Operator session; the API key cannot run them",
          )
        : errorResponse(401, "unauthorized", "Sign in as an Operator"),
    };
  }
  const verdict: ManualActionAuthorization = await authorizeManualAction(
    db,
    user.id,
    target,
  );
  if (verdict === "forbidden") {
    return {
      response: errorResponse(
        403,
        "forbidden",
        "Only an Operator of the Ticket's Team can run Manual Actions",
      ),
    };
  }
  return { actor: userActor(user.id) };
}

type ActionResult = { kind: string; message?: string; details?: unknown };

const conflictCodes = new Set([
  "illegal_state",
  "illegal_transition",
  "not_rerunnable",
  "already_queued",
]);

export async function manualTicketAction(
  request: Request,
  params: Promise<{ id: string }>,
  run: (
    db: Db,
    ticketId: string,
    body: unknown,
    actor: Actor,
  ) => Promise<ActionResult>,
  { withBody = true, successStatus = 200 } = {},
): Promise<Response> {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return errorResponse(404, "not_found", "Unknown ticket");
  }
  const db = getDb();
  const operator = await rejectUnlessOperator(request, db, { ticketId: id });
  if ("response" in operator) return operator.response;
  let body: unknown;
  if (withBody) {
    try {
      body = await request.json();
    } catch {
      return errorResponse(422, "validation_error", "Body must be valid JSON");
    }
  }

  const result = await run(db, id, body, operator.actor);
  if (result.kind === "ok" || result.kind === "queued") {
    return Response.json({ ticketId: id }, { status: successStatus });
  }
  if (result.kind === "not_found") {
    return errorResponse(404, "not_found", "Unknown ticket");
  }
  if (result.kind === "invalid") {
    return errorResponse(
      422,
      "validation_error",
      "Invalid request",
      result.details,
    );
  }
  if (conflictCodes.has(result.kind)) {
    return errorResponse(
      409,
      result.kind === "illegal_transition" ? result.kind : "conflict",
      result.message ?? "The Ticket is not in a state that allows this action",
    );
  }
  throw new Error(`Unhandled action result: ${result.kind}`);
}
