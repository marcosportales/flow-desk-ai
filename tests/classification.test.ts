import { describe, expect, it } from "vitest";
import { Classification } from "@/domain/classification";

const valid = {
  category: "erp",
  summary: "SAP invoice posting fails for the whole finance team",
  blocks_work: true,
  impact_scope: "team",
  reason: "Finance cannot post invoices, which stops month-end close.",
};

describe("Classification schema", () => {
  it("accepts a well-formed Classification", () => {
    expect(Classification.parse(valid)).toEqual(valid);
  });

  it.each([
    { name: "a missing field", input: { ...valid, reason: undefined } },
    { name: "an extra field", input: { ...valid, priority: "urgent" } },
    { name: "an unknown category", input: { ...valid, category: "hardware" } },
    {
      name: "an unknown impact scope",
      input: { ...valid, impact_scope: "everyone" },
    },
    {
      name: "a non-boolean blocks_work",
      input: { ...valid, blocks_work: "yes" },
    },
    { name: "an empty summary", input: { ...valid, summary: "" } },
    {
      name: "a summary over 200 characters",
      input: { ...valid, summary: "x".repeat(201) },
    },
    {
      name: "a reason over 500 characters",
      input: { ...valid, reason: "x".repeat(501) },
    },
  ])("rejects $name", ({ input }) => {
    expect(Classification.safeParse(input).success).toBe(false);
  });
});
