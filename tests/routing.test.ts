import { describe, expect, it } from "vitest";
import { isDispatchable, routeFor, teamFor } from "@/domain/routing";

describe("Team lookup", () => {
  // IMPLEMENTATION.md §2.1.
  it.each([
    { category: "erp", team: "it_systems", dispatchable: true },
    { category: "access", team: "identity_access", dispatchable: true },
    { category: "data", team: "data_team", dispatchable: true },
    { category: "inquiry", team: "service_desk", dispatchable: false },
    { category: "other", team: "service_desk", dispatchable: false },
  ] as const)(
    "$category → $team (dispatchable: $dispatchable)",
    ({ category, team, dispatchable }) => {
      expect(teamFor(category)).toBe(team);
      expect(isDispatchable(category)).toBe(dispatchable);
    },
  );
});

describe("routeFor", () => {
  it.each([
    { priority: "urgent", route: "urgent" },
    { priority: "high", route: "standard" },
    { priority: "normal", route: "standard" },
    { priority: "low", route: "standard" },
  ] as const)("$priority → $route", ({ priority, route }) => {
    expect(routeFor(priority)).toBe(route);
  });
});
