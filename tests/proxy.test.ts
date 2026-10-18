import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";

function visit(path: string, cookie?: string) {
  return proxy(
    new NextRequest(`http://localhost:3000${path}`, {
      headers: cookie ? { cookie } : {},
    }),
  );
}

// Same pattern Next uses to decide which paths run the proxy.
function runsOn(path: string) {
  return new RegExp(`^${config.matcher[0]}$`).test(path);
}

describe("proxy", () => {
  it("redirects an unauthenticated visit to /tickets to sign-in", () => {
    const res = visit("/tickets");
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/sign-in");
  });

  it("lets a request with a session cookie through", () => {
    const res = visit("/tickets", "better-auth.session_token=abc.def");
    expect(res.headers.get("location")).toBeNull();
  });

  it("covers every page but leaves sign-in and the API routes alone", () => {
    for (const path of ["/", "/tickets", "/tickets/new", "/tickets/123"]) {
      expect(runsOn(path), path).toBe(true);
    }
    for (const path of [
      "/sign-in",
      "/api/health",
      "/api/webhooks/n8n",
      "/api/tickets",
      "/api/auth/sign-in/email",
      "/_next/static/chunk.js",
    ]) {
      expect(runsOn(path), path).toBe(false);
    }
  });
});
