import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "@/infra/db/client";
import * as schema from "@/infra/db/schema";

// Created on first use, so importing this module (e.g. during `next build`)
// doesn't require DATABASE_URL or BETTER_AUTH_SECRET.
let auth: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
  auth ??= createAuth();
  return auth;
}

function createAuth() {
  return betterAuth({
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    user: {
      additionalFields: {
        department: { type: "string", required: false, input: false },
      },
    },
    // Users are seeded; nobody signs themselves up.
    emailAndPassword: { enabled: true, disableSignUp: true },
    advanced: { database: { generateId: "uuid" } },
    plugins: [nextCookies()],
  });
}
