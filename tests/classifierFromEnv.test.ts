import { describe, expect, it } from "vitest";
import { classifierFromEnv } from "@/infra/classifier";

describe("classifierFromEnv", () => {
  it("defaults to the fake classifier in valid mode", async () => {
    const classifier = classifierFromEnv({});
    expect(classifier.provider).toBe("fake");
    const { rawOutput } = await classifier.classify({
      title: "t",
      description: "SAP is down",
    });
    expect(JSON.parse(rawOutput).category).toBe("erp");
  });

  it("honours FAKE_CLASSIFIER_MODE", async () => {
    const classifier = classifierFromEnv({
      CLASSIFIER: "fake",
      FAKE_CLASSIFIER_MODE: "provider_error",
    });
    await expect(
      classifier.classify({ title: "t", description: "d" }),
    ).rejects.toThrow();
  });

  it("builds the OpenAI-compatible classifier from LLM_*", () => {
    const classifier = classifierFromEnv({
      CLASSIFIER: "openai_compatible",
      LLM_BASE_URL: "https://llm.example/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "m",
    });
    expect(classifier).toMatchObject({
      provider: "openai_compatible",
      model: "m",
    });
  });

  it("fails fast when the OpenAI-compatible settings are incomplete", () => {
    expect(() =>
      classifierFromEnv({ CLASSIFIER: "openai_compatible", LLM_MODEL: "m" }),
    ).toThrow(/LLM_BASE_URL/);
  });

  it("rejects unknown values", () => {
    expect(() => classifierFromEnv({ CLASSIFIER: "magic" })).toThrow(
      /CLASSIFIER/,
    );
    expect(() => classifierFromEnv({ FAKE_CLASSIFIER_MODE: "oops" })).toThrow(
      /FAKE_CLASSIFIER_MODE/,
    );
  });
});
