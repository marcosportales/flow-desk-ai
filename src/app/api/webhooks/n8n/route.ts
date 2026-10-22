import { rejectUnlessSigned } from "@/infra/api/auth";
import { respondToDispatchCallback } from "../dispatchCallback";

export const dynamic = "force-dynamic";

// n8n's callback: authenticated by HMAC, not the API key. IMPLEMENTATION.md §4.5.
export async function POST(request: Request) {
  // Verified against the exact bytes n8n signed, before parsing.
  const body = await request.text();
  const unsigned = rejectUnlessSigned(request, body, "N8N_TO_FLOWDESK_SECRET");
  if (unsigned) return unsigned;
  return respondToDispatchCallback(body);
}
