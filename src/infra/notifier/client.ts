import { z } from "zod";

// Reconciliation's question to the target service: "did you receive this
// id?" (ADR 0006, IMPLEMENTATION.md §4.6, §6).

export type NotifierConfig = { notifierUrl: string };

const REQUEST_TIMEOUT_MS = 10_000;

export function notifierConfigFromEnv(
  env: Record<string, string | undefined>,
): NotifierConfig {
  const parsed = z.url().safeParse(env.NOTIFIER_URL || "http://notifier:4000");
  if (!parsed.success) throw new Error("Invalid NOTIFIER_URL");
  return { notifierUrl: parsed.data.replace(/\/+$/, "") };
}

// Throws when the notifier cannot answer, so the caller retries later.
export async function deliveryExists(
  { notifierUrl }: NotifierConfig,
  dispatchId: string,
): Promise<boolean> {
  const response = await fetch(
    `${notifierUrl}/deliveries/${encodeURIComponent(dispatchId)}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  await response.body?.cancel();
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new Error(`notifier answered HTTP ${response.status}`);
}
