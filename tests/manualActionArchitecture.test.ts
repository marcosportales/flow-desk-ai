import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every Manual Action goes through the gate in src/infra/manualActions/gate.ts
// (SCRUM-39), so none can skip the permission check or the revalidation. The
// adapters are the only callers of the gate; these checks make sure the routes
// and Server Actions use them.

const root = join(import.meta.dirname, "..");

const manualActionRouteDirs = [
  "src/app/api/tickets/[id]",
  "src/app/api/dispatches/[id]",
];
const serverActionsFile = "src/app/tickets/[id]/actions.ts";

function routeFiles(dir: string): string[] {
  return readdirSync(join(root, dir), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name === "route.ts")
    .map((entry) => join(entry.parentPath, entry.name));
}

// A route's POST must be exactly `export const POST = manualActionRoute(…)`.
function postBypassesGate(source: string): boolean {
  const mentions = source.match(/\bPOST\b/g) ?? [];
  if (mentions.length === 0) return false;
  return (
    mentions.length !== 1 ||
    !/^export const POST = manualActionRoute\(/m.test(source)
  );
}

// Every exported value of the Server Actions file is a `manualActionForm(…)`.
function serverActionsBypassingGate(source: string): string[] {
  return [...source.matchAll(/^export\s+(?!type\b)(.*)$/gm)]
    .map((match) => match[1]!)
    .filter((rest) => !/^const \w+ = manualActionForm\(/.test(rest));
}

describe("the Manual Action gate", () => {
  it("catches a POST that skips it", () => {
    expect(
      postBypassesGate(
        "export async function POST(request: Request) { return run(); }",
      ),
    ).toBe(true);
    expect(
      postBypassesGate(
        "export const POST = manualActionRoute(take);\nexport { other as POST };",
      ),
    ).toBe(true);
    expect(postBypassesGate("export async function GET() {}")).toBe(false);
    expect(
      serverActionsBypassingGate(
        "export async function takeAction() {}\nexport type State = {};",
      ),
    ).toEqual(["async function takeAction() {}"]);
  });

  it("is used by every POST route on a Ticket or a Dispatch", () => {
    const files = manualActionRouteDirs.flatMap(routeFiles);
    expect(files.length).toBeGreaterThanOrEqual(9);
    const bypassing = files.filter((file) =>
      postBypassesGate(readFileSync(file, "utf8")),
    );
    expect(bypassing).toEqual([]);
  });

  it("is used by every Server Action on the Ticket page", () => {
    const source = readFileSync(join(root, serverActionsFile), "utf8");
    expect(source).toMatch(/manualActionForm\(/);
    expect(serverActionsBypassingGate(source)).toEqual([]);
  });
});
