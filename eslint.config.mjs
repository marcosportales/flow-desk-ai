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
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".claude/worktrees/**",
  ]),
]);
