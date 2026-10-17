import { signBody } from "@/infra/crypto/hmac";
import type { DispatchConfig } from "./config";

// Signed event client for the n8n dispatch webhook: IMPLEMENTATION.md §4.4.

const REQUEST_TIMEOUT_MS = 10_000;

export type SendResult =
  | { ok: true; httpStatus: number }
  | { ok: false; httpStatus: number | null; error: string };

export async function sendDispatchEvent(
  n8n: Pick<DispatchConfig, "webhookUrl" | "secret">,
  body: string,
): Promise<SendResult> {
  try {
    const response = await fetch(n8n.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signBody(n8n.secret, body),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok
      ? { ok: true, httpStatus: response.status }
      : {
          ok: false,
          httpStatus: response.status,
          error: `n8n answered HTTP ${response.status}`,
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
