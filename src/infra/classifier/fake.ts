import type { Classification } from "@/domain/classification";
import {
  type Classifier,
  type ClassifierInput,
  type ClassifierOutput,
  ClassifierProviderError,
} from "./types";

export const fakeClassifierModes = [
  "valid",
  "invalid",
  "timeout",
  "provider_error",
] as const;
export type FakeClassifierMode = (typeof fakeClassifierModes)[number];

const has = (text: string, pattern: RegExp) => pattern.test(text);

// Keyword rules for the PLAN.md example Requests; deterministic, no network.
function classifyByKeywords(text: string): Classification {
  const t = text.toLowerCase();
  const blocks = has(
    t,
    /haven't been able|can't|cannot|unable|blocked|not working|down\b/,
  );
  const impact_scope = has(
    t,
    /whole company|entire company|company-wide|everyone|all employees/,
  )
    ? "organization"
    : has(t, /\bteam\b|\bdepartment\b|all of us/)
      ? "team"
      : "individual";

  if (has(t, /\bsap\b|\berp\b|invoice/)) {
    return {
      category: "erp",
      summary: "Problem using the ERP system",
      blocks_work: blocks,
      impact_scope,
      reason: "The request mentions SAP, the ERP or invoices.",
    };
  }
  if (has(t, /access to|permission|password|new employee|account/)) {
    return {
      category: "access",
      summary: "Request for access to a tool or account",
      blocks_work: blocks,
      impact_scope,
      reason: "The request asks for access or account changes.",
    };
  }
  if (has(t, /report|dashboard|incorrect data|wrong data|dataset/)) {
    return {
      category: "data",
      summary: "Problem with reported data",
      blocks_work: blocks,
      impact_scope,
      reason: "The request is about reports or data quality.",
    };
  }
  if (has(t, /status|update on|any news|follow.?up/)) {
    return {
      category: "inquiry",
      summary: "Question about an earlier request",
      blocks_work: false,
      impact_scope: "individual",
      reason: "The request asks for information, not an action.",
    };
  }
  return {
    category: "other",
    summary: "Request that fits no known category",
    blocks_work: false,
    impact_scope: "individual",
    reason: "No keyword matched a known category.",
  };
}

export class FakeClassifier implements Classifier {
  readonly provider = "fake";
  readonly model = "fake-keyword-v1";

  constructor(private readonly mode: FakeClassifierMode = "valid") {}

  async classify(input: ClassifierInput): Promise<ClassifierOutput> {
    switch (this.mode) {
      case "timeout":
        throw new ClassifierProviderError("fake classifier: timeout");
      case "provider_error":
        throw new ClassifierProviderError("fake classifier: provider error");
      case "invalid":
        // Fails the schema (unknown category, missing keys), repair included.
        return { rawOutput: JSON.stringify({ category: "not-a-category" }) };
      case "valid":
        return {
          rawOutput: JSON.stringify(
            classifyByKeywords(`${input.title}\n${input.description}`),
          ),
        };
    }
  }
}
