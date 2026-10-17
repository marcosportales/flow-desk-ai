import { describe, expect, it } from "vitest";
import {
  evaluatePriority,
  type Priority,
  type PriorityFacts,
  type PriorityRuleName,
} from "@/domain/priority";

describe("evaluatePriority", () => {
  // Expected values come straight from IMPLEMENTATION.md §2.3.
  it.each<{
    name: string;
    facts: PriorityFacts;
    priority: Priority;
    rule: PriorityRuleName;
  }>([
    // Each rule on its own.
    {
      name: "org-wide blocker",
      facts: {
        category: "access",
        blocks_work: true,
        impact_scope: "organization",
      },
      priority: "urgent",
      rule: "org_wide_blocker",
    },
    {
      name: "ERP blocker for one person",
      facts: { category: "erp", blocks_work: true, impact_scope: "individual" },
      priority: "urgent",
      rule: "erp_blocker",
    },
    {
      name: "team blocker",
      facts: { category: "data", blocks_work: true, impact_scope: "team" },
      priority: "high",
      rule: "team_blocker",
    },
    {
      name: "individual blocker",
      facts: {
        category: "access",
        blocks_work: true,
        impact_scope: "individual",
      },
      priority: "normal",
      rule: "individual_blocker",
    },
    {
      name: "non-blocking request",
      facts: {
        category: "data",
        blocks_work: false,
        impact_scope: "individual",
      },
      priority: "low",
      rule: "default",
    },
    // Ordering: the first matching rule wins.
    {
      name: "ERP org-wide blocker matches org_wide_blocker first",
      facts: {
        category: "erp",
        blocks_work: true,
        impact_scope: "organization",
      },
      priority: "urgent",
      rule: "org_wide_blocker",
    },
    {
      name: "ERP team blocker is urgent, not high",
      facts: { category: "erp", blocks_work: true, impact_scope: "team" },
      priority: "urgent",
      rule: "erp_blocker",
    },
    {
      name: "team blocker is high, not normal",
      facts: { category: "other", blocks_work: true, impact_scope: "team" },
      priority: "high",
      rule: "team_blocker",
    },
    // Without blocks_work, scope and category never raise Priority.
    {
      name: "non-blocking org-wide request",
      facts: {
        category: "access",
        blocks_work: false,
        impact_scope: "organization",
      },
      priority: "low",
      rule: "default",
    },
    {
      name: "non-blocking ERP request",
      facts: { category: "erp", blocks_work: false, impact_scope: "team" },
      priority: "low",
      rule: "default",
    },
    {
      name: "non-blocking inquiry",
      facts: {
        category: "inquiry",
        blocks_work: false,
        impact_scope: "individual",
      },
      priority: "low",
      rule: "default",
    },
  ])("$name → $priority via $rule", ({ facts, priority, rule }) => {
    const result = evaluatePriority(facts);
    expect(result.priority).toBe(priority);
    expect(result.rule).toBe(rule);
  });

  it("reports every rule in order, including those after the winner", () => {
    const result = evaluatePriority({
      category: "data",
      blocks_work: true,
      impact_scope: "team",
    });
    expect(result.evaluated).toEqual([
      { rule: "org_wide_blocker", priority: "urgent", matched: false },
      { rule: "erp_blocker", priority: "urgent", matched: false },
      { rule: "team_blocker", priority: "high", matched: true },
      { rule: "individual_blocker", priority: "normal", matched: true },
      { rule: "default", priority: "low", matched: true },
    ]);
  });
});
