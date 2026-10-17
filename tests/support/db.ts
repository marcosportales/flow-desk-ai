import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/infra/db/schema";
import { testDatabaseUrl } from "./testDatabaseUrl";

export function connectTestDb() {
  const sql = postgres(testDatabaseUrl, { max: 1, onnotice: () => {} });
  return { sql, db: drizzle(sql, { schema }) };
}

export type TestDb = ReturnType<typeof connectTestDb>["db"];

// Resolves to the name of the constraint (or unique index) Postgres reported.
export async function violatedConstraint(query: PromiseLike<unknown>) {
  try {
    await query;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    const name = (cause as { constraint_name?: string }).constraint_name;
    if (name) return name;
    throw error;
  }
  throw new Error("expected the query to violate a constraint");
}
