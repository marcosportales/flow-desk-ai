import { describe, expect, it } from "vitest";
import { Classification } from "@/domain/classification";
import { FakeClassifier } from "@/infra/classifier/fake";
import { ClassifierProviderError } from "@/infra/classifier/types";

async function classify(description: string) {
  const { rawOutput } = await new FakeClassifier("valid").classify({
    title: "Request",
    description,
  });
  return Classification.parse(JSON.parse(rawOutput));
}

describe("FakeClassifier valid mode", () => {
  it("classifies an SAP blocker as an ERP issue that blocks work", async () => {
    const result = await classify(
      "I haven't been able to access SAP since this morning, and I need to process some invoices.",
    );
    expect(result).toMatchObject({
      category: "erp",
      blocks_work: true,
      impact_scope: "individual",
    });
  });

  it("classifies a new-employee tool request as access", async () => {
    const result = await classify(
      "I need access to a tool for a new employee.",
    );
    expect(result).toMatchObject({ category: "access", blocks_work: false });
  });

  it("classifies bad report numbers as data", async () => {
    const result = await classify(
      "The sales report has been showing incorrect data since yesterday.",
    );
    expect(result).toMatchObject({ category: "data", blocks_work: false });
  });

  it("classifies a status question as an inquiry", async () => {
    const result = await classify(
      "I need an update on the status of a previous request.",
    );
    expect(result.category).toBe("inquiry");
  });

  it("falls back to other", async () => {
    const result = await classify("The office plants need watering again.");
    expect(result.category).toBe("other");
  });

  it("reads organization-wide impact from the text", async () => {
    const result = await classify(
      "Nobody in the whole company can log in to the ERP, we are blocked.",
    );
    expect(result).toMatchObject({
      blocks_work: true,
      impact_scope: "organization",
    });
  });
});

describe("FakeClassifier failure modes", () => {
  const input = { title: "Request", description: "Anything at all here." };

  it("invalid mode returns output that fails the schema, even on repair", async () => {
    const classifier = new FakeClassifier("invalid");
    for (const repair of [undefined, { previousOutput: "x", error: "bad" }]) {
      const { rawOutput } = await classifier.classify({ ...input, repair });
      expect(Classification.safeParse(JSON.parse(rawOutput)).success).toBe(
        false,
      );
    }
  });

  it("timeout and provider_error modes throw a provider error", async () => {
    for (const mode of ["timeout", "provider_error"] as const) {
      await expect(
        new FakeClassifier(mode).classify(input),
      ).rejects.toBeInstanceOf(ClassifierProviderError);
    }
  });
});
