import { rejectUnlessBearer } from "@/infra/api/auth";
import { respondToDispatchCallback } from "../dispatchCallback";

export const dynamic = "force-dynamic";

// Power Automate's callback. It cannot sign with HMAC, so it sends a bearer
// secret instead (ADR 0011). Active whatever WORKFLOW_ENGINE says, so
// Dispatches in flight when the engine is switched still settle.
export async function POST(request: Request) {
  const unauthorized = rejectUnlessBearer(
    request,
    "POWER_AUTOMATE_TO_FLOWDESK_SECRET",
  );
  if (unauthorized) return unauthorized;
  return respondToDispatchCallback(await request.text());
}
