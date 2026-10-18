import { z } from "zod";
import { errorResponse } from "@/infra/api/errors";
import { getAuth } from "@/infra/auth/auth";
import {
  demoEmailDomain,
  demoPassword,
  demoSignInEnabled,
} from "@/infra/auth/demo";

export const dynamic = "force-dynamic";

const body = z.object({ email: z.email() });

// Backs the "Sign in as <name>" shortcuts. Only the seeded demo Users (all
// share the demo password) can be reached, and only while DEMO_SIGN_IN is not
// "off".
export async function POST(request: Request) {
  const forbidden = () =>
    errorResponse(403, "forbidden", "Demo sign-in is not available");
  if (!demoSignInEnabled()) return forbidden();

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !parsed.data.email.endsWith(demoEmailDomain)) {
    return forbidden();
  }

  // Better Auth's own response carries the session cookie.
  const response = await getAuth().api.signInEmail({
    body: { email: parsed.data.email, password: demoPassword },
    headers: request.headers,
    asResponse: true,
  });
  return response.ok ? response : forbidden();
}
