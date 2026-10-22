import {
  startWorkflowEngineStub,
  type StubOptions,
} from "./workflowEngineStub";

export type { StubRequest } from "./workflowEngineStub";

// Answers like n8n's webhook node, which replies 202.
export const startN8nStub = (options: StubOptions = {}) =>
  startWorkflowEngineStub("/webhook/flowdesk-dispatch", options);
