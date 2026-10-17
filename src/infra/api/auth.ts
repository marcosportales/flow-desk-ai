import { timingSafeEqual } from "node:crypto";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignature,
} from "@/infra/crypto/hmac";
import { errorResponse } from "./errors";

// Returns a 401 response when the request lacks a valid `X-API-Key`, else null.
export function rejectUnlessAuthorized(request: Request): Response | null {
  const expected = process.env.FLOWDESK_API_KEY;
  const given = request.headers.get("x-api-key");
  if (expected && given && safeEqual(given, expected)) return null;
  return errorResponse(401, "unauthorized", "Missing or invalid X-API-Key");
}

// Returns a 401 response unless `body` carries a valid, fresh HMAC signature
// made with the secret in env var `secretName`, else null.
export function rejectUnlessSigned(
  request: Request,
  body: string,
  secretName: string,
): Response | null {
  const secret = process.env[secretName];
  if (!secret) {
    return errorResponse(500, "misconfigured", `${secretName} is not set`);
  }
  const verified = verifySignature({
    secret,
    body,
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    signature: request.headers.get(SIGNATURE_HEADER),
  });
  if (verified.ok) return null;
  return errorResponse(
    401,
    verified.reason,
    verified.reason === "stale_timestamp"
      ? "Missing timestamp or skew over 5 minutes"
      : "Missing or invalid signature",
  );
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
