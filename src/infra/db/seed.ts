import { createHash } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { demoPassword } from "../auth/demo";
import {
  type Actor,
  actorColumns,
  systemActor,
  userActor,
} from "../../domain/actor";
import type { Team } from "../../domain/routing";
import * as schema from "./schema";
import {
  accounts,
  classificationAttempts,
  dispatchAttempts,
  dispatches,
  jobs,
  teamMemberships,
  ticketEvents,
  tickets,
  users,
} from "./schema";

// Demo data. Safe to run on every start: Users are matched by email and
// Tickets by their idempotency key, so rows that already exist are left alone.

// Any Drizzle Postgres database or transaction over this schema.
type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
type Ticket = typeof tickets.$inferSelect;

// Requesters belong to no Team; Operators belong to one or more. Everyone signs
// in with the same fixed demo password.
const seedUsers: (typeof users.$inferInsert & { teams?: Team[] })[] = [
  {
    name: "Ana Morales",
    email: "ana.morales@flowdesk.example",
    department: "Finance",
  },
  {
    name: "Ben Okafor",
    email: "ben.okafor@flowdesk.example",
    department: "Sales",
  },
  {
    name: "Chloé Martin",
    email: "chloe.martin@flowdesk.example",
    department: "Operations",
  },
  {
    name: "Dev Patel",
    email: "dev.patel@flowdesk.example",
    department: "Engineering",
  },
  {
    name: "Elena Rossi",
    email: "elena.rossi@flowdesk.example",
    department: "People",
  },
  {
    name: "Farid Haddad",
    email: "farid.haddad@flowdesk.example",
    department: "Logistics",
  },
  {
    name: "Grace Lindqvist",
    email: "grace.lindqvist@flowdesk.example",
    department: "IT",
    teams: ["it_systems"],
  },
  {
    name: "Hiro Tanaka",
    email: "hiro.tanaka@flowdesk.example",
    department: "IT",
    teams: ["identity_access"],
  },
  {
    name: "Ines Duarte",
    email: "ines.duarte@flowdesk.example",
    department: "Data",
    teams: ["data_team"],
  },
  {
    name: "Jonas Weber",
    email: "jonas.weber@flowdesk.example",
    department: "Service Desk",
    teams: ["service_desk"],
  },
  {
    name: "Kofi Mensah",
    email: "kofi.mensah@flowdesk.example",
    department: "IT",
    teams: ["it_systems", "data_team"],
  },
];

type ClassificationFacts = Pick<
  typeof tickets.$inferInsert,
  "category" | "summary" | "blocksWork" | "impactScope" | "team"
>;

type SeedTicket = {
  key: string;
  requester: string;
  hoursAgo: number;
  title: string;
  description: string;
  status?: Ticket["status"];
  // Classification outcomes in order; omitted means not yet attempted.
  attempts?: ("valid" | "invalid_output")[];
  classification?: ClassificationFacts & {
    reason: string;
    computedPriority: NonNullable<Ticket["priority"]>;
    priorityRule: string;
  };
  override?: { priority: NonNullable<Ticket["priority"]>; reason: string };
  // "failed" means the automatic attempts ran out.
  dispatch?: "succeeded" | "failed";
};

const seedTickets: SeedTicket[] = [
  {
    key: "seed-erp-invoice-posting",
    requester: "ana.morales@flowdesk.example",
    hoursAgo: 50,
    title: "Invoice posting fails in the ERP",
    description:
      "Since this morning every invoice we post in the ERP fails with 'period locked'. The whole AP team is stuck.",
    attempts: ["valid"],
    classification: {
      category: "erp",
      summary: "ERP rejects invoice posting for the AP team",
      blocksWork: true,
      impactScope: "team",
      team: "it_systems",
      reason: "Posting is blocked for the accounts payable team.",
      computedPriority: "urgent",
      priorityRule: "erp_blocker",
    },
    dispatch: "succeeded",
  },
  {
    key: "seed-vpn-new-hire",
    requester: "elena.rossi@flowdesk.example",
    hoursAgo: 46,
    title: "VPN access for a new hire",
    description:
      "Our new recruiter starts Monday and will need VPN access to the HR systems from home.",
    status: "resolved",
    attempts: ["valid"],
    classification: {
      category: "access",
      summary: "VPN access needed for a new hire",
      blocksWork: false,
      impactScope: "individual",
      team: "identity_access",
      reason: "Access request for one person, nothing blocked yet.",
      computedPriority: "low",
      priorityRule: "default",
    },
    dispatch: "succeeded",
  },
  {
    key: "seed-sso-outage",
    requester: "dev.patel@flowdesk.example",
    hoursAgo: 40,
    title: "Nobody can sign in with SSO",
    description:
      "Single sign-on returns an error page for everyone in the company. Email, chat and the ERP are all unreachable.",
    status: "closed",
    attempts: ["valid"],
    classification: {
      category: "access",
      summary: "Company-wide SSO outage",
      blocksWork: true,
      impactScope: "organization",
      team: "identity_access",
      reason: "Everyone is locked out of core tools.",
      computedPriority: "urgent",
      priorityRule: "org_wide_blocker",
    },
    dispatch: "succeeded",
  },
  {
    key: "seed-sales-dashboard",
    requester: "ben.okafor@flowdesk.example",
    hoursAgo: 26,
    title: "Sales dashboard shows last week's numbers",
    description:
      "The regional sales dashboard has not refreshed since last Thursday. We can still work from the CRM exports.",
    attempts: ["valid"],
    classification: {
      category: "data",
      summary: "Sales dashboard stopped refreshing",
      blocksWork: false,
      impactScope: "team",
      team: "data_team",
      reason: "Stale data for the sales team, with a workaround.",
      computedPriority: "low",
      priorityRule: "default",
    },
    dispatch: "failed",
  },
  {
    key: "seed-stock-report",
    requester: "farid.haddad@flowdesk.example",
    hoursAgo: 20,
    title: "Stock report export is empty",
    description:
      "Exporting the daily stock report gives me an empty file, so I cannot plan tomorrow's shipments.",
    attempts: ["valid"],
    classification: {
      category: "data",
      summary: "Daily stock report exports empty",
      blocksWork: true,
      impactScope: "individual",
      team: "data_team",
      reason: "One planner is blocked from preparing shipments.",
      computedPriority: "normal",
      priorityRule: "individual_blocker",
    },
    override: {
      priority: "high",
      reason: "Shipments for three warehouses depend on this report.",
    },
    dispatch: "succeeded",
  },
  {
    key: "seed-inquiry-erp-ticket",
    requester: "ana.morales@flowdesk.example",
    hoursAgo: 8,
    title: "Any update on the invoice posting problem?",
    description:
      "I reported the invoice posting failure two days ago. Is anyone looking at it?",
    attempts: ["valid"],
    classification: {
      category: "inquiry",
      summary: "Asks for news on the ERP invoice posting ticket",
      blocksWork: false,
      impactScope: "individual",
      team: "service_desk",
      reason: "Asks about an earlier Ticket.",
      computedPriority: "low",
      priorityRule: "default",
    },
  },
  {
    key: "seed-unreadable-request",
    requester: "chloe.martin@flowdesk.example",
    hoursAgo: 3,
    title: "printer??",
    description: "it does the thing again, same as last time, pls fix asap",
    attempts: ["invalid_output", "invalid_output"],
  },
  {
    key: "seed-pending-access",
    requester: "chloe.martin@flowdesk.example",
    hoursAgo: 0,
    title: "Shared drive asks for a password",
    description:
      "The Operations shared drive started asking me for a password I never had.",
  },
];

// sha256 of the normalized Request, as stored in tickets.request_hash.
function requestHash(requesterId: string, title: string, description: string) {
  return createHash("sha256")
    .update(JSON.stringify([requesterId, title.trim(), description.trim()]))
    .digest("hex");
}

export async function seedDatabase(db: Db) {
  await db.transaction(async (tx) => {
    const emails = seedUsers.map((u) => u.email);
    await tx
      .insert(users)
      .values(
        seedUsers.map(({ email, name, department }) => ({
          email,
          name,
          department,
        })),
      )
      .onConflictDoNothing();
    const seeded = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.email, emails));
    const userIds = new Map(seeded.map((u) => [u.email, u.id]));

    const withCredential = new Set(
      (
        await tx
          .select({ userId: accounts.userId })
          .from(accounts)
          .where(inArray(accounts.userId, [...userIds.values()]))
      ).map((a) => a.userId),
    );
    const passwordHash = await hashPassword(demoPassword);
    for (const user of seedUsers) {
      const userId = userIds.get(user.email)!;
      if (!withCredential.has(userId)) {
        await tx.insert(accounts).values({
          userId,
          accountId: userId,
          providerId: "credential",
          password: passwordHash,
        });
      }
      if (user.teams) {
        await tx
          .insert(teamMemberships)
          .values(user.teams.map((team) => ({ userId, team })))
          .onConflictDoNothing();
      }
    }

    // Human-initiated events are attributed to an Operator of the Ticket's Team.
    const operators = new Map<Team, string>();
    for (const user of seedUsers) {
      for (const team of user.teams ?? []) {
        if (!operators.has(team)) operators.set(team, userIds.get(user.email)!);
      }
    }

    for (const seed of seedTickets) {
      await seedTicket(tx, seed, userIds.get(seed.requester)!, operators);
    }
  });
}

const DISPATCH_FAILED_ATTEMPTS = 3;
const CALLBACK_TIMEOUT_MS = 60_000;

async function seedTicket(
  db: Db,
  seed: SeedTicket,
  requesterId: string,
  operators: Map<Team, string>,
) {
  const createdAt = new Date(Date.now() - seed.hoursAgo * 3_600_000);
  // Each later event happens a minute after the previous one.
  let minute = 0;
  const at = () => new Date(createdAt.getTime() + minute++ * 60_000);

  const classification = seed.classification;
  const classified = classification && classification.category !== "inquiry";
  const priority = seed.override?.priority ?? classification?.computedPriority;
  const [ticket] = await db
    .insert(tickets)
    .values({
      requesterId,
      title: seed.title,
      description: seed.description,
      status: seed.status ?? "open",
      classificationState: classified
        ? "classified"
        : seed.attempts
          ? "needs_review"
          : "pending",
      ...(classification && {
        category: classification.category,
        summary: classification.summary,
        blocksWork: classification.blocksWork,
        impactScope: classification.impactScope,
        team: classification.team,
        classificationSource: "ai" as const,
        computedPriority: classification.computedPriority,
        priorityRule: classification.priorityRule,
        priority,
        priorityOverrideReason: seed.override?.reason,
      }),
      idempotencyKey: seed.key,
      requestHash: requestHash(requesterId, seed.title, seed.description),
      createdAt,
      updatedAt: createdAt,
    })
    .onConflictDoNothing({
      target: [tickets.requesterId, tickets.idempotencyKey],
    })
    .returning();
  if (!ticket) return;

  const events: (typeof ticketEvents.$inferInsert)[] = [];
  const event = (
    type: string,
    actor: Actor,
    data: Record<string, unknown> = {},
  ) =>
    events.push({
      ticketId: ticket.id,
      type,
      ...actorColumns(actor),
      data,
      createdAt: at(),
    });
  const operator = userActor(operators.get(ticket.team ?? "service_desk")!);

  event("ticket_created", userActor(requesterId), { number: ticket.number });

  if (!seed.attempts) {
    await db.insert(jobs).values({ kind: "classify", ticketId: ticket.id });
  }

  for (const [i, outcome] of (seed.attempts ?? []).entries()) {
    const valid = outcome === "valid";
    await db.insert(classificationAttempts).values({
      ticketId: ticket.id,
      attemptNo: i + 1,
      kind: i === 0 ? "initial" : "repair",
      outcome,
      provider: "fake",
      model: "fake-classifier",
      ...(valid && classification
        ? {
            parsed: {
              category: classification.category,
              summary: classification.summary,
              blocks_work: classification.blocksWork,
              impact_scope: classification.impactScope,
              reason: classification.reason,
            },
          }
        : {
            rawOutput: "Sure! It sounds like a printer issue.",
            error: "Output is not valid JSON",
          }),
      latencyMs: 800 + i * 150,
      createdAt: at(),
    });
    event("classification_attempted", systemActor, {
      attempt_no: i + 1,
      outcome,
    });
  }

  if (classification) {
    if (classified) {
      event("classified", systemActor, {
        category: classification.category,
        team: classification.team,
      });
    }
    event("priority_computed", systemActor, {
      priority: classification.computedPriority,
      rule: classification.priorityRule,
    });
    if (seed.override) {
      event("priority_overridden", operator, {
        from: classification.computedPriority,
        to: seed.override.priority,
        reason: seed.override.reason,
      });
    }
    if (!classified)
      event("sent_to_review", systemActor, { reason: "inquiry" });
  } else if (seed.attempts) {
    event("sent_to_review", systemActor, { reason: "invalid_output" });
  }

  if (classified && seed.dispatch && priority) {
    const succeeded = seed.dispatch === "succeeded";
    const attemptCount = succeeded ? 1 : DISPATCH_FAILED_ATTEMPTS;
    const [dispatch] = await db
      .insert(dispatches)
      .values({
        ticketId: ticket.id,
        sequence: 1,
        category: classification.category!,
        priority,
        team: classification.team!,
        route: priority === "urgent" ? "urgent" : "standard",
        status: seed.dispatch,
        autoAttempts: attemptCount,
        createdAt: at(),
      })
      .returning();
    const dispatchId = dispatch!.id;
    event("dispatch_created", systemActor, { dispatch_id: dispatchId });

    for (let attemptNo = 1; attemptNo <= attemptCount; attemptNo++) {
      const startedAt = at();
      // n8n accepts with 202; the delivery outcome arrives by callback.
      const finishedAt = succeeded ? at() : startedAt;
      await db.insert(dispatchAttempts).values({
        dispatchId,
        attemptNo,
        trigger: "auto",
        ...(succeeded
          ? {
              outcome: "succeeded",
              httpStatus: 202,
              n8nExecutionId: `seed-exec-${seed.key}`,
            }
          : {
              outcome: "failed",
              httpStatus: 502,
              error: "n8n webhook returned 502",
            }),
        startedAt,
        finishedAt,
        createdAt: startedAt,
      });
      event("dispatch_attempted", systemActor, {
        dispatch_id: dispatchId,
        attempt_no: attemptNo,
      });
      if (succeeded) {
        await db
          .update(dispatches)
          .set({
            callbackDeadline: new Date(
              startedAt.getTime() + CALLBACK_TIMEOUT_MS,
            ),
            updatedAt: finishedAt,
          })
          .where(eq(dispatches.id, dispatchId));
      }
    }
    if (succeeded) {
      event("dispatch_succeeded", systemActor, { dispatch_id: dispatchId });
    } else {
      event("dispatch_failed", systemActor, { dispatch_id: dispatchId });
    }
  }

  if (seed.status === "resolved" || seed.status === "closed") {
    event("status_changed", operator, { from: "open", to: "resolved" });
  }
  if (seed.status === "closed") {
    event("status_changed", operator, { from: "resolved", to: "closed" });
  }

  await db.insert(ticketEvents).values(events);
}
