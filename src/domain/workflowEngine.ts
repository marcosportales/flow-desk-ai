// The Workflow Engine a deployment sends its Dispatches to: ADR 0011.

export const workflowEngines = ["n8n", "power_automate"] as const;
export type WorkflowEngine = (typeof workflowEngines)[number];

export const workflowEngineLabels: Record<WorkflowEngine, string> = {
  n8n: "n8n",
  power_automate: "Power Automate",
};
