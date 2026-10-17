import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { testDatabaseUrl } from "./testDatabaseUrl";

// Every run starts from an empty database, so the migrations themselves are
// exercised from scratch.
export default async function setup() {
  const sql = postgres(testDatabaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`drop schema if exists drizzle cascade`;
    await sql`drop schema if exists public cascade`;
    await sql`create schema public`;
    await migrate(drizzle(sql), {
      migrationsFolder: new URL(
        "../../src/infra/db/migrations",
        import.meta.url,
      ).pathname,
    });
  } finally {
    await sql.end();
  }
}
