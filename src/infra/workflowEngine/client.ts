import { workflowEngineLabels } from "@/domain/workflowEngine";
import { signBody } from "@/infra/crypto/hmac";
import type { EngineTarget } from "./config";

// Sends a Dispatch event to the configured Workflow Engine:
// IMPLEMENTATION.md §4.4, ADR 0011. n8n gets the body HMAC-signed; Power
// Automate cannot verify HMAC, and its trigger URL's `sig` authenticates the
// call instead.

const REQUEST_TIMEOUT_MS = 10_000;

export type SendResult =
  | { ok: true; httpStatus: number }
  | { ok: false; httpStatus: number | null; error: string };

export async function sendDispatchEvent(
  engine: EngineTarget,
  body: string,
): Promise<SendResult> {
  const [url, auth] =
    engine.kind === "n8n"
      ? [engine.webhookUrl, signBody(engine.secret, body)]
      : [engine.triggerUrl, {}];
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok
      ? { ok: true, httpStatus: response.status }
      : {
          ok: false,
          httpStatus: response.status,
          error: `${workflowEngineLabels[engine.kind]} answered HTTP ${response.status}`,
        };
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    return {
      ok: false,
      httpStatus: null,
      error: [(error as Error).message, cause].filter(Boolean).join(": "),
    };
  }
}
