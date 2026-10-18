import { integrationActor } from "@/domain/actor";
import { rejectUnlessAuthorized } from "@/infra/api/auth";
import { errorResponse } from "@/infra/api/errors";
import { getDb } from "@/infra/db/client";
import { createTicket, type Ticket } from "@/services/createTicket";
import { listTickets } from "@/services/listTickets";

export const dynamic = "force-dynamic";

// Idempotency internals stay server-side.
function publicTicket(ticket: Ticket) {
  const rest: Partial<Ticket> = { ...ticket };
  delete rest.requestHash;
  delete rest.idempotencyKey;
  return rest;
}

export async function GET(request: Request) {
  const unauthorized = rejectUnlessAuthorized(request);
  if (unauthorized) return unauthorized;

  // Repeated params: the first one wins, as on the /tickets page.
  const query: Record<string, string> = {};
  for (const [k, v] of new URL(request.url).searchParams) query[k] ??= v;
  const result = await listTickets(getDb(), query);
  if (result.kind === "invalid") {
    return errorResponse(
      422,
      "validation_error",
      "Invalid query",
      result.details,
    );
  }
  const { tickets, total, page, pageSize } = result;
  return Response.json({ tickets, total, page, pageSize });
}

export async function POST(request: Request) {
  const unauthorized = rejectUnlessAuthorized(request);
  if (unauthorized) return unauthorized;

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return errorResponse(
      422,
      "validation_error",
      "Idempotency-Key header is required",
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(422, "validation_error", "Body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(422, "validation_error", "Body must be a JSON object");
  }

  const result = await createTicket(
    getDb(),
    { ...body, idempotencyKey },
    integrationActor,
  );
  switch (result.kind) {
    case "created":
      return Response.json(
        { ticket: publicTicket(result.ticket) },
        { status: 202 },
      );
    case "replayed":
      return Response.json(
        { ticket: publicTicket(result.ticket) },
        { status: 200 },
      );
    case "conflict":
      return errorResponse(
        409,
        "idempotency_conflict",
        "Idempotency-Key was already used with a different request",
      );
    case "invalid":
      return errorResponse(
        422,
        "validation_error",
        "Invalid request",
        result.details,
      );
  }
}
