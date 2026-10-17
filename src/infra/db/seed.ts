import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import {
  classificationAttempts,
  dispatchAttempts,
  dispatches,
  jobs,
  requesters,
  ticketEvents,
  tickets,
} from "./schema";

// Demo data. Safe to run on every start: Requesters are matched by email and
// Tickets by their idempotency key, so rows that already exist are left alone.

// Any Drizzle Postgres database or transaction over this schema.
type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
type Ticket = typeof tickets.$inferSelect;

const seedRequesters = [
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
] satisfies (typeof requesters.$inferInsert)[];

type Facts = Pick<
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
  classification?: Facts & {
    reason: string;
    computedPriority: NonNullable<Ticket["priority"]>;
    priorityRule: string;
  };
  override?: { priority: NonNullable<Ticket["priority"]>; reason: string };
  dispatch?: { status: "succeeded" | "failed"; failedAttempts: number };
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
    dispatch: { status: "succeeded", failedAttempts: 0 },
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
    dispatch: { status: "succeeded", failedAttempts: 0 },
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
    dispatch: { status: "succeeded", failedAttempts: 0 },
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
    dispatch: { status: "failed", failedAttempts: 3 },
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
    dispatch: { status: "succeeded", failedAttempts: 0 },
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
      summary: "Follow-up on the ERP invoice posting ticket",
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
    await tx.insert(requesters).values(seedRequesters).onConflictDoNothing();
    const people = await tx
      .select({ id: requesters.id, email: requesters.email })
      .from(requesters)
      .where(
        inArray(
          requesters.email,
          seedRequesters.map((r) => r.email),
        ),
      );
    const requesterIds = new Map(people.map((p) => [p.email, p.id]));

    for (const seed of seedTickets) {
      await seedTicket(tx, seed, requesterIds.get(seed.requester)!);
    }
  });
}

async function seedTicket(db: Db, seed: SeedTicket, requesterId: string) {
  const createdAt = new Date(Date.now() - seed.hoursAgo * 3_600_000);
  // Each later event happens a minute after the previous one.
  let minute = 0;
  const at = () => new Date(createdAt.getTime() + minute++ * 60_000);

  const c = seed.classification;
  const classified = c && c.category !== "inquiry";
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
      ...(c && {
        category: c.category,
        summary: c.summary,
        blocksWork: c.blocksWork,
        impactScope: c.impactScope,
        team: c.team,
        classificationSource: "ai" as const,
        computedPriority: c.computedPriority,
        priorityRule: c.priorityRule,
        priority: seed.override?.priority ?? c.computedPriority,
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
    actor: (typeof ticketEvents.$inferInsert)["actor"],
    data: Record<string, unknown> = {},
  ) => events.push({ ticketId: ticket.id, type, actor, data, createdAt: at() });

  event("ticket_created", "system", { number: ticket.number });

  if (!seed.attempts) {
    await db.insert(jobs).values({ kind: "classify", ticketId: ticket.id });
  }

  for (const [i, outcome] of (seed.attempts ?? []).entries()) {
    await db.insert(classificationAttempts).values({
      ticketId: ticket.id,
      attemptNo: i + 1,
      kind: i === 0 ? "initial" : "repair",
      outcome,
      provider: "fake",
      model: "fake-classifier",
      rawOutput:
        outcome === "invalid_output"
          ? "Sure! It sounds like a printer issue."
          : null,
      parsed:
        outcome === "valid" && c
          ? {
              category: c.category,
              summary: c.summary,
              blocks_work: c.blocksWork,
              impact_scope: c.impactScope,
              reason: c.reason,
            }
          : null,
      error: outcome === "invalid_output" ? "Output is not valid JSON" : null,
      latencyMs: 800 + i * 150,
      createdAt: at(),
    });
    event("classification_attempted", "ai", { attempt_no: i + 1, outcome });
  }

  if (c && !classified) {
    event("sent_to_review", "system", { reason: "inquiry" });
  } else if (!c && seed.attempts) {
    event("sent_to_review", "system", { reason: "invalid_output" });
  }

  if (classified) {
    event("classified", "ai", { category: c.category, team: c.team });
    event("priority_computed", "system", {
      priority: c.computedPriority,
      rule: c.priorityRule,
    });
    if (seed.override) {
      event("priority_overridden", "human", {
        from: c.computedPriority,
        to: seed.override.priority,
        reason: seed.override.reason,
      });
    }
  }

  if (classified && seed.dispatch) {
    const effectivePriority = seed.override?.priority ?? c.computedPriority;
    const [dispatch] = await db
      .insert(dispatches)
      .values({
        ticketId: ticket.id,
        sequence: 1,
        category: c.category!,
        priority: effectivePriority,
        team: c.team!,
        route: effectivePriority === "urgent" ? "urgent" : "standard",
        status: seed.dispatch.status,
        autoAttempts: Math.max(1, seed.dispatch.failedAttempts),
        createdAt: at(),
      })
      .returning();
    event("dispatch_created", "system", { dispatch_id: dispatch!.id });

    const attemptCount = Math.max(1, seed.dispatch.failedAttempts);
    for (let n = 1; n <= attemptCount; n++) {
      const succeeded = seed.dispatch.status === "succeeded";
      const startedAt = at();
      await db.insert(dispatchAttempts).values({
        dispatchId: dispatch!.id,
        attemptNo: n,
        trigger: "auto",
        outcome: succeeded ? "succeeded" : "failed",
        httpStatus: succeeded ? 200 : 502,
        n8nExecutionId: succeeded ? `seed-exec-${seed.key}` : null,
        error: succeeded ? null : "Notifier returned 502",
        startedAt,
        finishedAt: startedAt,
        createdAt: startedAt,
      });
      event("dispatch_attempted", "system", {
        dispatch_id: dispatch!.id,
        attempt_no: n,
      });
    }
    event(
      seed.dispatch.status === "succeeded"
        ? "dispatch_succeeded"
        : "dispatch_failed",
      "n8n",
      { dispatch_id: dispatch!.id },
    );
  }

  if (seed.status === "resolved" || seed.status === "closed") {
    event("status_changed", "human", { from: "open", to: "resolved" });
  }
  if (seed.status === "closed") {
    event("status_changed", "human", { from: "resolved", to: "closed" });
  }

  await db.insert(ticketEvents).values(events);
}
