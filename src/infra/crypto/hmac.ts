import { createHmac, timingSafeEqual } from "node:crypto";

// Signed messages between the app and n8n: IMPLEMENTATION.md §4.4, §4.5.
// The signature covers `timestamp + "." + body`, so a captured request can't
// be replayed with a fresh timestamp. Each direction has its own secret.

export const TIMESTAMP_HEADER = "X-FlowDesk-Timestamp";
export const SIGNATURE_HEADER = "X-FlowDesk-Signature";
export const MAX_SKEW_MS = 5 * 60_000;

function digest(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export function signBody(secret: string, body: string, now = new Date()) {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: `sha256=${digest(secret, timestamp, body)}`,
  };
}

type VerifyInput = {
  secret: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
  now?: Date;
};

export type VerifyResult =
  { ok: true } | { ok: false; reason: "bad_signature" | "stale_timestamp" };

export function verifySignature({
  secret,
  body,
  timestamp,
  signature,
  now = new Date(),
}: VerifyInput): VerifyResult {
  const seconds = Number(timestamp);
  if (
    !timestamp ||
    !Number.isInteger(seconds) ||
    Math.abs(now.getTime() - seconds * 1000) > MAX_SKEW_MS
  ) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const given = Buffer.from(signature?.replace(/^sha256=/, "") ?? "", "hex");
  const expected = Buffer.from(digest(secret, timestamp, body), "hex");
  if (
    !signature?.startsWith("sha256=") ||
    given.length !== expected.length ||
    !timingSafeEqual(given, expected)
  ) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
