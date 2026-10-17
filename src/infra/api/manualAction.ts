import { z } from "zod";
import { getDb } from "@/infra/db/client";
import type { Db } from "@/services/createTicket";
import { rejectUnlessAuthorized } from "./auth";
import { errorResponse } from "./errors";

// Shared plumbing for the manual Ticket actions (IMPLEMENTATION.md §4.7, §7):
// API key, id and JSON body checks, then the service result as a response.

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
  run: (db: Db, ticketId: string, body: unknown) => Promise<ActionResult>,
  { withBody = true, successStatus = 200 } = {},
): Promise<Response> {
  const unauthorized = rejectUnlessAuthorized(request);
  if (unauthorized) return unauthorized;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return errorResponse(404, "not_found", "Unknown ticket");
  }
  let body: unknown;
  if (withBody) {
    try {
      body = await request.json();
    } catch {
      return errorResponse(422, "validation_error", "Body must be valid JSON");
    }
  }

  const result = await run(getDb(), id, body);
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
