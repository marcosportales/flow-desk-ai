import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { requireDatabaseUrl } from "./env";

const sql = postgres(requireDatabaseUrl(), { max: 1 });
await migrate(drizzle(sql), {
  migrationsFolder: new URL("./migrations", import.meta.url).pathname,
});
await sql.end();
console.log("migrations applied");
