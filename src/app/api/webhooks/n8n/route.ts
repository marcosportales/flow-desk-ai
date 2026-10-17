import { z } from "zod";
import { errorResponse } from "@/infra/api/errors";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignature,
} from "@/infra/crypto/hmac";
import { getDb } from "@/infra/db/client";
import {
  DispatchCallback,
  recordDispatchCallback,
} from "@/services/recordDispatchCallback";

export const dynamic = "force-dynamic";

// n8n's callback: authenticated by HMAC (N8N_TO_FLOWDESK_SECRET), not the
// API key. IMPLEMENTATION.md §4.5.
export async function POST(request: Request) {
  const secret = process.env.N8N_TO_FLOWDESK_SECRET;
  if (!secret) {
    return errorResponse(500, "misconfigured", "Callback secret is not set");
  }

  // Verified against the exact bytes n8n signed, before parsing.
  const body = await request.text();
  const verified = verifySignature({
    secret,
    body,
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    signature: request.headers.get(SIGNATURE_HEADER),
  });
  if (!verified.ok) {
    return errorResponse(
      401,
      verified.reason,
      verified.reason === "stale_timestamp"
        ? "Missing timestamp or skew over 5 minutes"
        : "Missing or invalid signature",
    );
  }

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
