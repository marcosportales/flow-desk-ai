import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as demoSignIn } from "@/app/api/demo-sign-in/route";
import { getAuth } from "@/infra/auth/auth";
import { demoPassword } from "@/infra/auth/demo";
import { getSql } from "@/infra/db/client";
import { seedDatabase } from "@/infra/db/seed";
import { connectTestDb } from "./support/db";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

process.env.DATABASE_URL = testDatabaseUrl;
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-32";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

const { sql, db } = connectTestDb();
beforeAll(() => seedDatabase(db));
afterAll(async () => {
  await sql.end();
  await getSql().end();
});

const ana = "ana.morales@flowdesk.example";

function demoRequest(email: string) {
  return new Request("http://localhost:3000/api/demo-sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

function cookieHeader(response: Response) {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

describe("email and password sign-in", () => {
  it("signs a seeded User in with the demo password", async () => {
    const result = await getAuth().api.signInEmail({
      body: { email: ana, password: demoPassword },
    });
    expect(result.user.email).toBe(ana);
  });

  it("rejects a wrong password", async () => {
    await expect(
      getAuth().api.signInEmail({
        body: { email: ana, password: "not-the-password" },
      }),
    ).rejects.toThrow();
  });

  it("does not let anyone sign themselves up", async () => {
    await expect(
      getAuth().api.signUpEmail({
        body: {
          email: "mallory@flowdesk.example",
          name: "Mallory",
          password: "a-long-enough-password",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("POST /api/demo-sign-in", () => {
  it("signs in as a seeded User and sets a session cookie", async () => {
    const res = await demoSignIn(demoRequest(ana));
    expect(res.status).toBe(200);

    const session = await getAuth().api.getSession({
      headers: new Headers({ cookie: cookieHeader(res) }),
    });
    expect(session?.user.email).toBe(ana);
  });

  it("refuses an email that is not a seeded User", async () => {
    const res = await demoSignIn(demoRequest("nobody@example.com"));
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("refuses everything when the shortcuts are disabled", async () => {
    process.env.DEMO_SIGN_IN = "off";
    try {
      const res = await demoSignIn(demoRequest(ana));
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    } finally {
      delete process.env.DEMO_SIGN_IN;
    }
  });
});

describe("sign-out", () => {
  it("ends the session", async () => {
    const signedIn = await demoSignIn(demoRequest(ana));
    const headers = new Headers({ cookie: cookieHeader(signedIn) });
    expect(await getAuth().api.getSession({ headers })).not.toBeNull();

    await getAuth().api.signOut({ headers });

    expect(await getAuth().api.getSession({ headers })).toBeNull();
  });
});
