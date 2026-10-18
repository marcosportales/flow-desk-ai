import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The layering in docs/plan/IMPLEMENTATION.md, enforced by
// no-restricted-imports in eslint.config.mjs (SCRUM-40): src/domain does no
// I/O, and src/app reaches the database only through src/services.

const root = join(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: root });

async function restrictedImports(file: string, source: string) {
  const [result] = await eslint.lintText(source, {
    filePath: join(root, file),
  });
  return result!.messages
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message);
}

describe("layer boundaries", () => {
  it.each([
    `import { getDb } from "@/infra/db/client";`,
    `import { createTicket } from "@/services/createTicket";`,
    `import { GET } from "@/app/api/health/route";`,
    `import { redirect } from "next/navigation";`,
    `import { NextResponse } from "next/server";`,
    `import { eq } from "drizzle-orm";`,
    `import { pgTable } from "drizzle-orm/pg-core";`,
    `import { getDb } from "../infra/db/client";`,
    `import { createTicket } from "../services/createTicket";`,
  ])("keeps src/domain free of I/O: %s", async (source) => {
    expect(
      await restrictedImports("src/domain/example.ts", source),
    ).toHaveLength(1);
  });

  it.each([
    `import { eq } from "drizzle-orm";`,
    `import { users } from "@/infra/db/schema";`,
    `import type { tickets } from "@/infra/db/schema";`,
    `import { users } from "@/infra/db/schema.ts";`,
    `import { users } from "../../infra/db/schema";`,
  ])("keeps the database out of src/app: %s", async (source) => {
    expect(
      await restrictedImports("src/app/example/page.tsx", source),
    ).toHaveLength(1);
  });

  it("lets each layer import what it is allowed to", async () => {
    expect(
      await restrictedImports(
        "src/domain/example.ts",
        `import { z } from "zod";\nimport { ticketTeam } from "@/domain/permissions";`,
      ),
    ).toEqual([]);
    expect(
      await restrictedImports(
        "src/app/example/route.ts",
        `import { getDb } from "@/infra/db/client";\nimport { listTickets } from "@/services/listTickets";`,
      ),
    ).toEqual([]);
    expect(
      await restrictedImports(
        "src/services/example.ts",
        `import { eq } from "drizzle-orm";\nimport { users } from "@/infra/db/schema";`,
      ),
    ).toEqual([]);
  });
});
