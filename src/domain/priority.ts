import type { Classification } from "./classification";

// Priority Rules: docs/plan/IMPLEMENTATION.md §2.3, ADR 0001.

export const priorities = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof priorities)[number];

export type PriorityFacts = Pick<
  Classification,
  "category" | "blocks_work" | "impact_scope"
>;

type PriorityRule = {
  name: string;
  priority: Priority;
  matches: (facts: PriorityFacts) => boolean;
};

// Ordered: the first rule that matches decides. `default` always matches.
const rules = [
  {
    name: "org_wide_blocker",
    priority: "urgent",
    matches: (f) => f.blocks_work && f.impact_scope === "organization",
  },
  {
    name: "erp_blocker",
    priority: "urgent",
    matches: (f) => f.category === "erp" && f.blocks_work,
  },
  {
    name: "team_blocker",
    priority: "high",
    matches: (f) => f.blocks_work && f.impact_scope === "team",
  },
  {
    name: "individual_blocker",
    priority: "normal",
    matches: (f) => f.blocks_work,
  },
  { name: "default", priority: "low", matches: () => true },
] as const satisfies readonly PriorityRule[];

export type PriorityRuleName = (typeof rules)[number]["name"];

export type RuleResult = {
  rule: PriorityRuleName;
  priority: Priority;
  matched: boolean;
};

export type PriorityEvaluation = {
  priority: Priority;
  rule: PriorityRuleName;
  // Every rule in order, so a Ticket can show why each did or didn't fire.
  evaluated: RuleResult[];
};

export function evaluatePriority(facts: PriorityFacts): PriorityEvaluation {
  const evaluated = rules.map((r) => ({
    rule: r.name,
    priority: r.priority,
    matched: r.matches(facts),
  }));
  // `default` always matches, so a winner always exists.
  const winner = evaluated.find((r) => r.matched)!;
  return { priority: winner.priority, rule: winner.rule, evaluated };
}
