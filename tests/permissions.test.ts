import { describe, expect, it } from "vitest";
import {
  canRunManualActions,
  isOperator,
  isRequester,
  ticketTeam,
} from "@/domain/permissions";
import type { Team } from "@/domain/routing";

const user = (id: string, teams: Team[] = []) => ({ id, teams });

const erpTicket = {
  requesterId: "ana",
  category: "erp",
  team: "it_systems",
} as const;
const uncategorised = {
  requesterId: "ana",
  category: null,
  team: null,
} as const;

describe("ticketTeam", () => {
  it("is the Ticket's Team once it has a Category", () => {
    expect(ticketTeam(erpTicket)).toBe("it_systems");
  });

  it("is service_desk while the Ticket has no Category", () => {
    expect(ticketTeam(uncategorised)).toBe("service_desk");
  });
});

describe("permission policy", () => {
  it.each([
    {
      name: "Requester only",
      user: user("ana"),
      ticket: erpTicket,
      requester: true,
      operator: false,
      manual: false,
    },
    {
      name: "Operator only",
      user: user("grace", ["it_systems"]),
      ticket: erpTicket,
      requester: false,
      operator: true,
      manual: true,
    },
    {
      name: "both Requester and Operator",
      user: user("ana", ["it_systems"]),
      ticket: erpTicket,
      requester: true,
      operator: true,
      manual: true,
    },
    {
      name: "neither",
      user: user("ben"),
      ticket: erpTicket,
      requester: false,
      operator: false,
      manual: false,
    },
    {
      name: "member of another Team",
      user: user("ines", ["data_team"]),
      ticket: erpTicket,
      requester: false,
      operator: false,
      manual: false,
    },
    {
      name: "service_desk member on a Ticket with no Category",
      user: user("jonas", ["service_desk"]),
      ticket: uncategorised,
      requester: false,
      operator: true,
      manual: true,
    },
    {
      name: "other Team member on a Ticket with no Category",
      user: user("grace", ["it_systems"]),
      ticket: uncategorised,
      requester: false,
      operator: false,
      manual: false,
    },
    {
      name: "User in two Teams, one of them the Ticket's",
      user: user("kofi", ["it_systems", "data_team"]),
      ticket: erpTicket,
      requester: false,
      operator: true,
      manual: true,
    },
    {
      name: "User in two Teams, neither the Ticket's",
      user: user("kofi", ["data_team", "service_desk"]),
      ticket: erpTicket,
      requester: false,
      operator: false,
      manual: false,
    },
  ] as const)("$name", ({ user, ticket, requester, operator, manual }) => {
    expect(isRequester(user, ticket)).toBe(requester);
    expect(isOperator(user, ticket)).toBe(operator);
    expect(canRunManualActions(user, ticket)).toBe(manual);
  });
});
