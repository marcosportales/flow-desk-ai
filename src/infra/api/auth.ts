import { timingSafeEqual } from "node:crypto";
import { errorResponse } from "./errors";

// Returns a 401 response when the request lacks a valid `X-API-Key`, else null.
export function rejectUnlessAuthorized(request: Request): Response | null {
  const expected = process.env.FLOWDESK_API_KEY;
  const given = request.headers.get("x-api-key");
  if (expected && given && safeEqual(given, expected)) return null;
  return errorResponse(401, "unauthorized", "Missing or invalid X-API-Key");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
