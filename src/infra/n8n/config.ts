import type { DispatchConfig } from "@/services/dispatchTicket";

type Env = Record<string, string | undefined>;

const DEFAULT_CALLBACK_URL = "http://app:3000/api/webhooks/n8n";

// Throws on a missing setting so the worker fails at start-up, not on the
// first Dispatch.
export function dispatchConfigFromEnv(env: Env): DispatchConfig {
  const require = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const timeout = Number(env.DISPATCH_CALLBACK_TIMEOUT_SECONDS ?? 60);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(
      "DISPATCH_CALLBACK_TIMEOUT_SECONDS must be a positive integer",
    );
  }
  return {
    webhookUrl: require("N8N_WEBHOOK_URL"),
    secret: require("FLOWDESK_TO_N8N_SECRET"),
    callbackUrl: env.FLOWDESK_CALLBACK_URL || DEFAULT_CALLBACK_URL,
    callbackTimeoutSeconds: timeout,
  };
}
