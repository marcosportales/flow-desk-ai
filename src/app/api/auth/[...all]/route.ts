import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/infra/auth/auth";

// Better Auth's own endpoints (sign-in, sign-out, session). Built per request
// so importing this module doesn't need the database.
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return toNextJsHandler(getAuth()).GET(request);
}

export function POST(request: Request) {
  return toNextJsHandler(getAuth()).POST(request);
}
