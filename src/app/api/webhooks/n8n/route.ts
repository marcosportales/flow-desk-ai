import { z } from "zod";
import { rejectUnlessSigned } from "@/infra/api/auth";
import { errorResponse } from "@/infra/api/errors";
import { getDb } from "@/infra/db/client";
import {
  DispatchCallback,
  recordDispatchCallback,
} from "@/services/recordDispatchCallback";

export const dynamic = "force-dynamic";

// n8n's callback: authenticated by HMAC, not the API key. IMPLEMENTATION.md §4.5.
export async function POST(request: Request) {
  // Verified against the exact bytes n8n signed, before parsing.
  const body = await request.text();
  const unsigned = rejectUnlessSigned(request, body, "N8N_TO_FLOWDESK_SECRET");
  if (unsigned) return unsigned;

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
