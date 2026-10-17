import { z } from "zod";

// Classification facts the AI extracts: docs/plan/IMPLEMENTATION.md §2.2.

export const categories = [
  "erp",
  "access",
  "data",
  "inquiry",
  "other",
] as const;
export type Category = (typeof categories)[number];

export const impactScopes = ["individual", "team", "organization"] as const;
export type ImpactScope = (typeof impactScopes)[number];

// Strict: an unexpected key means the model went off-script, so reject it.
export const Classification = z
  .object({
    category: z.enum(categories),
    summary: z.string().min(1).max(200),
    blocks_work: z.boolean(),
    impact_scope: z.enum(impactScopes),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type Classification = z.infer<typeof Classification>;
