import postgres, { type Sql } from "postgres";
import { requireDatabaseUrl } from "./env";

// Created on first use, so importing this module (e.g. during `next build`)
// doesn't require DATABASE_URL.
let sql: Sql | undefined;

export function getSql(): Sql {
  sql ??= postgres(requireDatabaseUrl(), { connect_timeout: 5 });
  return sql;
}
