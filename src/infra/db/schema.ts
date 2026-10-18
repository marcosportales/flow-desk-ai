import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { categories, impactScopes } from "../../domain/classification";
import { priorities } from "../../domain/priority";
import { routes, teams } from "../../domain/routing";
import {
  classificationStates,
  dispatchStatuses,
  ticketStatuses,
} from "../../domain/transitions";

// Data model: docs/plan/IMPLEMENTATION.md §3.
// Enums the domain reasons about take their values from src/domain.

export const ticketStatus = pgEnum("ticket_status", ticketStatuses);
export const classificationState = pgEnum(
  "classification_state",
  classificationStates,
);
export const category = pgEnum("category", categories);
export const impactScope = pgEnum("impact_scope", impactScopes);
export const classificationSource = pgEnum("classification_source", [
  "ai",
  "human",
]);
export const priority = pgEnum("priority", priorities);
export const team = pgEnum("team", teams);
export const classificationAttemptKind = pgEnum("classification_attempt_kind", [
  "initial",
  "repair",
  "rerun",
]);
export const classificationOutcome = pgEnum("classification_outcome", [
  "valid",
  "invalid_output",
  "provider_error",
]);
export const route = pgEnum("route", routes);
export const dispatchStatus = pgEnum("dispatch_status", dispatchStatuses);
export const dispatchTrigger = pgEnum("dispatch_trigger", [
  "auto",
  "manual",
  "reconcile",
]);
export const dispatchAttemptOutcome = pgEnum("dispatch_attempt_outcome", [
  "sent",
  "succeeded",
  "failed",
  "unknown",
]);
export const jobKind = pgEnum("job_kind", [
  "classify",
  "dispatch",
  "reconcile",
]);
export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "done",
  "dead",
]);
// `user`, `integration` and `system` are what new events record. `ai`, `human`
// and `n8n` are legacy values on events written before the actor named a User.
export const eventActor = pgEnum("event_actor", [
  "system",
  "ai",
  "human",
  "n8n",
  "user",
  "integration",
]);

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// Users, sessions, accounts and verifications are the Better Auth tables
// (ADR 0007); `department` is the one column of our own. A User has no role:
// Team memberships decide what they may do on a Ticket.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  department: text("department").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const teamMemberships = pgTable(
  "team_memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    team: team("team").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.team] })],
);

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").generatedAlwaysAsIdentity().unique(),
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    // The Request as submitted; never modified.
    description: text("description").notNull(),
    status: ticketStatus("status").notNull().default("open"),
    classificationState: classificationState("classification_state")
      .notNull()
      .default("pending"),
    category: category("category"),
    summary: text("summary"),
    blocksWork: boolean("blocks_work"),
    impactScope: impactScope("impact_scope"),
    classificationSource: classificationSource("classification_source"),
    // Effective Priority; differs from computedPriority only on a Priority Override.
    priority: priority("priority"),
    computedPriority: priority("computed_priority"),
    priorityRule: text("priority_rule"),
    priorityOverrideReason: text("priority_override_reason"),
    team: team("team"),
    // The Operator accountable for the Ticket; null while no one has taken it
    // (ADR 0008). Assignment never grants or removes permission.
    assigneeId: uuid("assignee_id").references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("tickets_requester_idempotency_key_unique").on(
      t.requesterId,
      t.idempotencyKey,
    ),
    check(
      "tickets_title_length",
      sql`char_length(${t.title}) between 3 and 200`,
    ),
    check(
      "tickets_description_length",
      sql`char_length(${t.description}) between 10 and 5000`,
    ),
    check(
      "tickets_classified_has_facts",
      sql`${t.classificationState} <> 'classified' or (
        ${t.category} is not null and ${t.summary} is not null
        and ${t.blocksWork} is not null and ${t.impactScope} is not null
        and ${t.priority} is not null and ${t.computedPriority} is not null
        and ${t.team} is not null and ${t.classificationSource} is not null
      )`,
    ),
    check(
      "tickets_override_has_reason",
      sql`(${t.priority} is distinct from ${t.computedPriority}) = (${t.priorityOverrideReason} is not null)
        and (${t.priorityOverrideReason} is null or btrim(${t.priorityOverrideReason}) <> '')`,
    ),
    index("tickets_status_idx").on(t.status),
    index("tickets_classification_state_idx").on(t.classificationState),
    index("tickets_category_idx").on(t.category),
    index("tickets_priority_idx").on(t.priority),
    index("tickets_created_at_idx").on(t.createdAt.desc()),
    index("tickets_assignee_id_idx").on(t.assigneeId),
  ],
);

export const classificationAttempts = pgTable(
  "classification_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id),
    attemptNo: integer("attempt_no").notNull(),
    kind: classificationAttemptKind("kind").notNull(),
    outcome: classificationOutcome("outcome").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // Kept for invalid outputs so they can be inspected (Scenario D).
    rawOutput: text("raw_output"),
    parsed: jsonb("parsed"),
    error: text("error"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("classification_attempts_ticket_attempt_no_unique").on(
      t.ticketId,
      t.attemptNo,
    ),
  ],
);

export const dispatches = pgTable(
  "dispatches",
  {
    // Also the Dispatch's idempotency key end-to-end (n8n and the notifier).
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id),
    sequence: integer("sequence").notNull(),
    // Snapshot of the routing decision at the time of the Dispatch.
    category: category("category").notNull(),
    priority: priority("priority").notNull(),
    team: team("team").notNull(),
    route: route("route").notNull(),
    status: dispatchStatus("status").notNull().default("pending"),
    autoAttempts: integer("auto_attempts").notNull().default(0),
    callbackDeadline: timestamp("callback_deadline", { withTimezone: true }),
    supersededBy: uuid("superseded_by").references(
      (): AnyPgColumn => dispatches.id,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("dispatches_ticket_sequence_unique").on(t.ticketId, t.sequence),
    uniqueIndex("dispatches_one_active_per_ticket")
      .on(t.ticketId)
      .where(sql`${t.status} in ('pending', 'sent', 'unknown')`),
  ],
);

// Append-only.
export const dispatchAttempts = pgTable(
  "dispatch_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dispatchId: uuid("dispatch_id")
      .notNull()
      .references(() => dispatches.id),
    attemptNo: integer("attempt_no").notNull(),
    trigger: dispatchTrigger("trigger").notNull(),
    outcome: dispatchAttemptOutcome("outcome").notNull(),
    httpStatus: integer("http_status"),
    n8nExecutionId: text("n8n_execution_id"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("dispatch_attempts_dispatch_attempt_no_unique").on(
      t.dispatchId,
      t.attemptNo,
    ),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: jobKind("kind").notNull(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id),
    dispatchId: uuid("dispatch_id").references(() => dispatches.id),
    status: jobStatus("status").notNull().default("queued"),
    // Backoff: a queued job is not claimable before run_at.
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    // Lease: a running job whose lock is stale is reclaimable.
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [
    // A null dispatch_id counts as one value, so a Ticket has at most one
    // active classify job.
    uniqueIndex("jobs_one_active_per_target")
      .on(
        t.kind,
        t.ticketId,
        sql`coalesce(${t.dispatchId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${t.status} in ('queued', 'running')`),
    index("jobs_claimable_idx").on(t.status, t.runAt),
  ],
);

// Append-only; `id` gives the order of events.
export const ticketEvents = pgTable(
  "ticket_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id),
    // ticket_created, classified, priority_computed, dispatch_succeeded, …
    // (full list in IMPLEMENTATION.md §3).
    type: text("type").notNull(),
    actor: eventActor("actor").notNull(),
    // The signed-in User behind a `user` event; null for every other actor.
    actorUserId: uuid("actor_user_id").references(() => users.id),
    data: jsonb("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ticket_events_ticket_id_idx").on(t.ticketId, t.id),
    check(
      "ticket_events_actor_user_check",
      sql`(${t.actor}::text = 'user') = (${t.actorUserId} is not null)`,
    ),
  ],
);
