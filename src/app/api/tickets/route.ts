import { rejectUnlessAuthorized } from "@/infra/api/auth";
import { errorResponse } from "@/infra/api/errors";
import { getDb } from "@/infra/db/client";
import { createTicket } from "@/services/createTicket";

export const dynamic = "force-dynamic";

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

  const result = await createTicket(getDb(), { ...body, idempotencyKey });
  switch (result.kind) {
    case "created":
      return Response.json({ ticket: result.ticket }, { status: 202 });
    case "replayed":
      return Response.json({ ticket: result.ticket }, { status: 200 });
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
