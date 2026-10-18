import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// One write path for status changes and Ticket Events (SCRUM-41), enforced by
// no-restricted-syntax in eslint.config.mjs: only src/services/ticketWrites.ts
// (and the seed) writes a status column or inserts into ticket_events.

const root = join(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: root });

async function restrictedSyntax(file: string, source: string) {
  const [result] = await eslint.lintText(source, {
    filePath: join(root, file),
  });
  return result!.messages
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

describe("status write path", () => {
  it.each([
    `await tx.insert(ticketEvents).values(event);`,
    `await db.insert(schema.ticketEvents).values(event);`,
    `await tx.update(tickets).set({ status: "resolved" });`,
    `await tx.update(tickets).set({ status });`,
    `await tx.update(tickets).set({ "status": "resolved" });`,
    `await tx.update(tickets).set({ summary, classificationState: "classified" });`,
    `await tx.update(dispatches).set({ status: "failed", callbackDeadline: null });`,
    `await tx.insert(dispatches).values({ ticketId, status: "sent" });`,
  ])("rejects a direct write outside the write path: %s", async (source) => {
    for (const file of ["src/services/example.ts", "src/app/api/example.ts"]) {
      expect(await restrictedSyntax(file, source)).toHaveLength(1);
    }
  });

  it("lets other columns and tables be written anywhere", async () => {
    expect(
      await restrictedSyntax(
        "src/services/example.ts",
        [
          `await tx.update(tickets).set({ externalReference });`,
          `await tx.insert(jobs).values({ kind: "dispatch", ticketId });`,
          `await tx.insert(dispatches).values({ ticketId, sequence: 1 });`,
          `const result = { status: "ok" };`,
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it.each(["src/services/ticketWrites.ts", "src/infra/db/seed.ts"])(
    "lets %s write statuses and Ticket Events",
    async (file) => {
      expect(
        await restrictedSyntax(
          file,
          `await tx.insert(ticketEvents).values(event);\nawait tx.update(tickets).set({ status: to });`,
        ),
      ).toEqual([]);
    },
  );
});
