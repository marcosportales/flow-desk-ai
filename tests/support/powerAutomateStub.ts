import {
  startWorkflowEngineStub,
  type StubOptions,
} from "./workflowEngineStub";

// Answers like Power Automate's "When an HTTP request is received" trigger,
// which replies 202 by default; options as for the n8n stub.
export const startPowerAutomateStub = (options: StubOptions = {}) =>
  startWorkflowEngineStub(
    "/workflows/flowdesk/triggers/manual/paths/invoke?api-version=1&sig=test-sig",
    options,
  );
