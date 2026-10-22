import { z } from "zod";
import type { WorkflowEngine } from "@/domain/workflowEngine";

// Where the worker sends every Dispatch, picked by WORKFLOW_ENGINE (ADR 0011).
export type EngineTarget =
  | {
      kind: "n8n";
      webhookUrl: string;
      // FLOWDESK_TO_N8N_SECRET; the callback has its own (N8N_TO_FLOWDESK_SECRET).
      secret: string;
    }
  | {
      kind: "power_automate";
      // Carries the trigger's `sig`, so it is a secret too.
      triggerUrl: string;
    };

export type DispatchConfig = {
  engine: EngineTarget;
  callbackUrl: string;
  callbackTimeoutSeconds: number;
};

// Empty values in .env count as unset.
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);

const shared = {
  FLOWDESK_CALLBACK_URL: z.preprocess(blankToUndefined, z.url().optional()),
  DISPATCH_CALLBACK_TIMEOUT_SECONDS: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().positive().default(60),
  ),
};

const envSchema = z.discriminatedUnion("WORKFLOW_ENGINE", [
  z.object({
    WORKFLOW_ENGINE: z.literal("n8n"),
    N8N_WEBHOOK_URL: z.preprocess(blankToUndefined, z.url()),
    FLOWDESK_TO_N8N_SECRET: z.preprocess(blankToUndefined, z.string()),
    ...shared,
  }),
  z.object({
    WORKFLOW_ENGINE: z.literal("power_automate"),
    POWER_AUTOMATE_TRIGGER_URL: z.preprocess(blankToUndefined, z.url()),
    // Read by the callback route, not the worker; checked here so a missing
    // secret fails at start-up rather than on the first callback.
    POWER_AUTOMATE_TO_FLOWDESK_SECRET: z.preprocess(
      blankToUndefined,
      z.string(),
    ),
    ...shared,
    // A Power Automate callback on the n8n route would fail its HMAC check.
    FLOWDESK_CALLBACK_URL: shared.FLOWDESK_CALLBACK_URL.refine(
      (url) => !url || new URL(url).pathname !== "/api/webhooks/n8n",
      "points to the n8n callback route",
    ),
  }),
]);

const defaultCallbackUrl = {
  n8n: "http://app:3000/api/webhooks/n8n",
  power_automate: "http://app:3000/api/webhooks/power-automate",
} satisfies Record<WorkflowEngine, string>;

// Throws on bad configuration so the worker fails at start-up, not on the
// first Dispatch.
export function dispatchConfigFromEnv(
  env: Record<string, string | undefined>,
): DispatchConfig {
  const parsed = envSchema.safeParse({
    ...env,
    WORKFLOW_ENGINE: blankToUndefined(env.WORKFLOW_ENGINE) ?? "n8n",
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid dispatch configuration: ${z.prettifyError(parsed.error)}`,
    );
  }
  const data = parsed.data;
  return {
    engine:
      data.WORKFLOW_ENGINE === "n8n"
        ? {
            kind: "n8n",
            webhookUrl: data.N8N_WEBHOOK_URL,
            secret: data.FLOWDESK_TO_N8N_SECRET,
          }
        : {
            kind: "power_automate",
            triggerUrl: data.POWER_AUTOMATE_TRIGGER_URL,
          },
    callbackUrl:
      data.FLOWDESK_CALLBACK_URL ?? defaultCallbackUrl[data.WORKFLOW_ENGINE],
    callbackTimeoutSeconds: data.DISPATCH_CALLBACK_TIMEOUT_SECONDS,
  };
}
