import { z } from "zod";
import { errorResponse } from "@/infra/api/errors";
import { getDb } from "@/infra/db/client";
import {
  DispatchCallback,
  recordDispatchCallback,
} from "@/services/recordDispatchCallback";

// What both Workflow Engines' callback routes do once the caller is
// authenticated: they report the same callback schema. IMPLEMENTATION.md §4.5.
export async function respondToDispatchCallback(
  body: string,
): Promise<Response> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return errorResponse(422, "validation_error", "Body must be valid JSON");
  }
  const parsed = DispatchCallback.safeParse(json);
  if (!parsed.success) {
    return errorResponse(
      422,
      "validation_error",
      "Invalid callback",
      z.flattenError(parsed.error),
    );
  }

  const result = await recordDispatchCallback(getDb(), parsed.data);
  if (result.kind === "not_found") {
    return errorResponse(404, "not_found", "Unknown dispatch_id");
  }
  return Response.json({ result: result.kind }, { status: 200 });
}
