import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

// Every page requires a session. This only checks that a session cookie is
// present, which is cheap and keeps anonymous visitors out; pages and Server
// Actions still validate the session itself (requireUser).
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();
  const signIn = new URL("/sign-in", request.url);
  return NextResponse.redirect(signIn);
}

export const config = {
  // API routes keep their own auth (X-API-Key, HMAC signature, Better Auth's
  // own endpoints); /sign-in and Next's assets are public.
  matcher: ["/((?!api/|sign-in|_next/|favicon.ico).*)"],
};
