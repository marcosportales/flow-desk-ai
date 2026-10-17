import { z } from "zod";

export type DispatchConfig = {
  webhookUrl: string;
  // FLOWDESK_TO_N8N_SECRET; the callback has its own (N8N_TO_FLOWDESK_SECRET).
  secret: string;
  callbackUrl: string;
  callbackTimeoutSeconds: number;
};

// Empty values in .env count as unset.
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);

const envSchema = z.object({
  N8N_WEBHOOK_URL: z.preprocess(blankToUndefined, z.url()),
  FLOWDESK_TO_N8N_SECRET: z.preprocess(blankToUndefined, z.string()),
  FLOWDESK_CALLBACK_URL: z.preprocess(
    blankToUndefined,
    z.url().default("http://app:3000/api/webhooks/n8n"),
  ),
  DISPATCH_CALLBACK_TIMEOUT_SECONDS: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().positive().default(60),
  ),
});

// Throws on bad configuration so the worker fails at start-up, not on the
// first Dispatch.
export function dispatchConfigFromEnv(
  env: Record<string, string | undefined>,
): DispatchConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid dispatch configuration: ${z.prettifyError(parsed.error)}`,
    );
  }
  return {
    webhookUrl: parsed.data.N8N_WEBHOOK_URL,
    secret: parsed.data.FLOWDESK_TO_N8N_SECRET,
    callbackUrl: parsed.data.FLOWDESK_CALLBACK_URL,
    callbackTimeoutSeconds: parsed.data.DISPATCH_CALLBACK_TIMEOUT_SECONDS,
  };
}
