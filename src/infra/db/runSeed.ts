import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requireDatabaseUrl } from "./env";
import * as schema from "./schema";
import { seedDatabase } from "./seed";

const sql = postgres(requireDatabaseUrl(), { max: 1 });
await seedDatabase(drizzle(sql, { schema }));
await sql.end();
console.log("seed applied");
