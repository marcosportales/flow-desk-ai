import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "@/infra/crypto/hmac";

const SECRET = "test-secret";
const BODY = JSON.stringify({ dispatch_id: "d-1", outcome: "succeeded" });
const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_SECONDS = String(NOW.getTime() / 1000);

describe("signBody", () => {
  it("signs `timestamp.body` with HMAC-SHA256, as n8n recomputes it", () => {
    const headers = signBody(SECRET, BODY, NOW);

    // Known-good value computed independently of the helper.
    const expected = createHmac("sha256", SECRET)
      .update(`1792238400.${BODY}`)
      .digest("hex");
    expect(headers).toEqual({
      "X-FlowDesk-Timestamp": "1792238400",
      "X-FlowDesk-Signature": `sha256=${expected}`,
    });
  });
});

describe("verifySignature", () => {
  const signed = signBody(SECRET, BODY, NOW);
  const valid = {
    secret: SECRET,
    body: BODY,
    timestamp: signed["X-FlowDesk-Timestamp"],
    signature: signed["X-FlowDesk-Signature"],
    now: NOW,
  };

  it("accepts a body signed with the same secret", () => {
    expect(verifySignature(valid)).toEqual({ ok: true });
  });

  it("accepts a timestamp within the 5-minute skew window", () => {
    const later = new Date(NOW.getTime() + 299_000);
    expect(verifySignature({ ...valid, now: later })).toEqual({ ok: true });
  });

  it.each([
    ["a tampered body", { body: BODY.replace("succeeded", "failed") }],
    ["a different secret", { secret: "other-secret" }],
    ["a malformed signature", { signature: "not-a-signature" }],
    ["a missing signature", { signature: null }],
  ])("rejects %s as a bad signature", (_name, change) => {
    expect(verifySignature({ ...valid, ...change })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it.each([
    ["older than 5 minutes", NOW.getTime() + 301_000],
    ["more than 5 minutes in the future", NOW.getTime() - 301_000],
  ])("rejects a timestamp %s as stale", (_name, nowMs) => {
    expect(verifySignature({ ...valid, now: new Date(nowMs) })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it.each([[null], ["yesterday"]])(
    "rejects a missing or non-numeric timestamp (%s)",
    (timestamp) => {
      expect(verifySignature({ ...valid, timestamp })).toEqual({
        ok: false,
        reason: "stale_timestamp",
      });
    },
  );

  it("rejects a re-signed timestamp swap: the timestamp is covered by the signature", () => {
    const swapped = String(Number(NOW_SECONDS) + 10);
    expect(verifySignature({ ...valid, timestamp: swapped })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});
