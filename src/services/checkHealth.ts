import type { Sql } from "postgres";

export type Health =
  { status: "ok"; database: "up" } | { status: "error"; database: "down" };

// Takes a getter so a missing or invalid connection config also reports "down".
export async function checkHealth(getSql: () => Sql): Promise<Health> {
  try {
    await getSql()`select 1`;
    return { status: "ok", database: "up" };
  } catch {
    return { status: "error", database: "down" };
  }
}
