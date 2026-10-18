import { z } from "zod";

// Reconciliation's question to the simulated ERP: "did you create an incident
// for this id?" (ADR 0006, ADR 0009).

export type ErpConfig = { erpUrl: string };

const REQUEST_TIMEOUT_MS = 10_000;

export function erpConfigFromEnv(
  env: Record<string, string | undefined>,
): ErpConfig {
  const parsed = z.url().safeParse(env.ERP_URL || "http://erp:4100");
  if (!parsed.success) throw new Error("Invalid ERP_URL");
  return { erpUrl: parsed.data.replace(/\/+$/, "") };
}

const Incident = z.object({ reference: z.string().min(1) });

// The incident's reference, or null when the ERP holds none for the id.
// Throws when the ERP cannot answer, so the caller retries later.
export async function findIncident(
  { erpUrl }: ErpConfig,
  dispatchId: string,
): Promise<{ reference: string } | null> {
  const response = await fetch(
    `${erpUrl}/incidents/${encodeURIComponent(dispatchId)}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`ERP answered HTTP ${response.status}`);
  }
  return Incident.parse(await response.json());
}
