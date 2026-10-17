import type { Category } from "./classification";
import type { Priority } from "./priority";

// Category → Team and Route: docs/plan/IMPLEMENTATION.md §2.1, §2.3.

export const teams = [
  "it_systems",
  "identity_access",
  "data_team",
  "service_desk",
] as const;
export type Team = (typeof teams)[number];

export const routes = ["standard", "urgent"] as const;
export type Route = (typeof routes)[number];

// Non-dispatchable Categories go to Manual Review instead of n8n.
const categoryTable: Record<Category, { team: Team; dispatchable: boolean }> = {
  erp: { team: "it_systems", dispatchable: true },
  access: { team: "identity_access", dispatchable: true },
  data: { team: "data_team", dispatchable: true },
  inquiry: { team: "service_desk", dispatchable: false },
  other: { team: "service_desk", dispatchable: false },
};

export function teamFor(category: Category): Team {
  return categoryTable[category].team;
}

export function isDispatchable(category: Category): boolean {
  return categoryTable[category].dispatchable;
}

export function routeFor(priority: Priority): Route {
  return priority === "urgent" ? "urgent" : "standard";
}
