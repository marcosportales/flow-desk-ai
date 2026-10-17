import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  transitionClassificationState,
  transitionDispatchStatus,
  transitionTicketStatus,
} from "@/domain/transitions";

describe("transitionTicketStatus", () => {
  it.each([
    { from: "open", to: "resolved" },
    { from: "resolved", to: "closed" },
    { from: "resolved", to: "open" },
  ] as const)("allows $from → $to", ({ from, to }) => {
    expect(transitionTicketStatus(from, to)).toBe(to);
  });

  it.each([
    { from: "open", to: "closed" },
    { from: "open", to: "open" },
    { from: "closed", to: "open" },
    { from: "closed", to: "resolved" },
  ] as const)("rejects $from → $to", ({ from, to }) => {
    expect(() => transitionTicketStatus(from, to)).toThrow(
      IllegalTransitionError,
    );
  });
});

describe("transitionClassificationState", () => {
  it.each([
    { from: "pending", to: "classified" },
    { from: "pending", to: "needs_review" },
    { from: "needs_review", to: "classified" },
    { from: "classified", to: "classified" },
  ] as const)("allows $from → $to", ({ from, to }) => {
    expect(transitionClassificationState(from, to)).toBe(to);
  });

  it.each([
    { from: "classified", to: "pending" },
    { from: "classified", to: "needs_review" },
    { from: "needs_review", to: "pending" },
    { from: "pending", to: "pending" },
  ] as const)("rejects $from → $to", ({ from, to }) => {
    expect(() => transitionClassificationState(from, to)).toThrow(
      IllegalTransitionError,
    );
  });
});

describe("transitionDispatchStatus", () => {
  it.each([
    { from: "pending", to: "sent" },
    // n8n never accepted it and the auto-retry budget ran out (§4.4).
    { from: "pending", to: "failed" },
    { from: "sent", to: "succeeded" },
    { from: "sent", to: "failed" },
    { from: "sent", to: "unknown" },
    { from: "unknown", to: "succeeded" },
    { from: "unknown", to: "failed" },
    { from: "failed", to: "pending" },
  ] as const)("allows $from → $to", ({ from, to }) => {
    expect(transitionDispatchStatus(from, to)).toBe(to);
  });

  it.each([
    { from: "pending", to: "succeeded" },
    { from: "pending", to: "unknown" },
    { from: "succeeded", to: "pending" },
    { from: "succeeded", to: "failed" },
    { from: "failed", to: "sent" },
    { from: "unknown", to: "pending" },
    { from: "unknown", to: "sent" },
    { from: "sent", to: "pending" },
  ] as const)("rejects $from → $to", ({ from, to }) => {
    expect(() => transitionDispatchStatus(from, to)).toThrow(
      IllegalTransitionError,
    );
  });

  it("names the axis and both statuses when it refuses", () => {
    expect(() => transitionDispatchStatus("succeeded", "failed")).toThrow(
      "Illegal Dispatch Status transition: succeeded → failed",
    );
  });
});
