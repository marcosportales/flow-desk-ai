import { z } from "zod";
import { FakeClassifier, fakeClassifierModes } from "./fake";
import { OpenAiCompatibleClassifier } from "./openai";
import type { Classifier } from "./types";

// Empty values in .env count as unset.
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);

const envSchema = z.object({
  CLASSIFIER: z.preprocess(
    blankToUndefined,
    z.enum(["fake", "openai_compatible"]).default("fake"),
  ),
  FAKE_CLASSIFIER_MODE: z.preprocess(
    blankToUndefined,
    z.enum(fakeClassifierModes).default("valid"),
  ),
  LLM_BASE_URL: z.preprocess(blankToUndefined, z.string().optional()),
  LLM_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  LLM_MODEL: z.preprocess(blankToUndefined, z.string().optional()),
});

// Throws on bad configuration so the worker fails at start-up, not on the
// first Ticket.
export function classifierFromEnv(
  env: Record<string, string | undefined>,
): Classifier {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid classifier configuration: ${z.prettifyError(parsed.error)}`,
    );
  }
  const config = parsed.data;
  if (config.CLASSIFIER === "fake") {
    return new FakeClassifier(config.FAKE_CLASSIFIER_MODE);
  }

  const missing = (
    ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const
  ).filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(
      `CLASSIFIER=openai_compatible requires ${missing.join(", ")}`,
    );
  }
  return new OpenAiCompatibleClassifier({
    baseUrl: config.LLM_BASE_URL!,
    apiKey: config.LLM_API_KEY!,
    model: config.LLM_MODEL!,
  });
}
