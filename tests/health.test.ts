import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { checkHealth } from "@/services/checkHealth";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://flowdesk:flowdesk@localhost:5432/flowdesk_test";

describe("checkHealth", () => {
  const reachable = postgres(databaseUrl, { max: 1 });
  const unreachable = postgres("postgres://nobody:nothing@127.0.0.1:1/none", {
    max: 1,
    connect_timeout: 1,
  });

  afterAll(async () => {
    await reachable.end();
    await unreachable.end();
  });

  it("reports healthy when the database answers", async () => {
    expect(await checkHealth(() => reachable)).toEqual({
      status: "ok",
      database: "up",
    });
  });

  it("reports unhealthy when the database cannot be reached", async () => {
    expect(await checkHealth(() => unreachable)).toEqual({
      status: "error",
      database: "down",
    });
  });

  it("reports unhealthy when the connection cannot be configured", async () => {
    const missingConfig = () => {
      throw new Error("DATABASE_URL is not set");
    };
    expect(await checkHealth(missingConfig)).toEqual({
      status: "error",
      database: "down",
    });
  });
});
