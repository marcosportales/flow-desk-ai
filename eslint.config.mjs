import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

// Layer boundaries (docs/plan/IMPLEMENTATION.md): src/domain does no I/O, and
// src/app reaches the database only through src/services.
const restrictImports = (patterns) => ({
  "no-restricted-imports": ["error", { patterns }],
});

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    files: ["src/domain/**"],
    rules: restrictImports([
      {
        regex: String.raw`^(@/|(\.\./)+)(infra|services)(/|$)`,
        message: "src/domain does no I/O; pass data in from src/services.",
      },
      {
        regex: String.raw`^(@/|(\.\./)+)app(/|$)`,
        message: "src/domain must not depend on the web layer.",
      },
      {
        group: ["next", "next/*"],
        message: "src/domain must not depend on the web layer.",
      },
      {
        group: ["drizzle-orm", "drizzle-orm/*"],
        message: "src/domain does no I/O; queries live in src/services.",
      },
    ]),
  },
  {
    files: ["src/app/**"],
    rules: restrictImports([
      {
        group: ["drizzle-orm", "drizzle-orm/*"],
        message:
          "src/app reaches the database only through src/services; move the query there.",
      },
      {
        regex: String.raw`^(@/|(\.\./)+)infra/db/schema(\.ts)?$`,
        message:
          "src/app reaches the database only through src/services; move the query there.",
      },
    ]),
  },
  // One write path for status changes and Ticket Events (ADR 0010): only
  // src/services/ticketWrites.ts checks a transition before writing it.
  {
    files: ["src/**"],
    ignores: ["src/services/ticketWrites.ts", "src/infra/db/seed.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `CallExpression[callee.property.name="insert"]:matches([arguments.0.name="ticketEvents"], [arguments.0.property.name="ticketEvents"])`,
          message:
            "Append Ticket Events through src/services/ticketWrites.ts (appendTicketEvent or a move* function).",
        },
        {
          selector: String.raw`CallExpression[callee.property.name=/^(set|values)$/] > ObjectExpression > Property:matches([key.name=/^(status|classificationState)$/], [key.value=/^(status|classificationState)$/])`,
          message:
            "Change a status through src/services/ticketWrites.ts (moveTicketStatus, moveClassificationState or moveDispatchStatus) so the transition is checked.",
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".claude/worktrees/**",
  ]),
]);
