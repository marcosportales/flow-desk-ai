import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  classificationAttempts,
  dispatchAttempts,
  dispatches,
  jobs,
  requesters,
  tickets,
} from "@/infra/db/schema";
import { connectTestDb, violatedConstraint } from "./support/db";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

async function newRequester() {
  const [requester] = await db
    .insert(requesters)
    .values({
      name: "Test Person",
      email: `${randomUUID()}@test.example`,
      department: "QA",
    })
    .returning();
  return requester!;
}

function ticketValues(
  requesterId: string,
  overrides: Partial<typeof tickets.$inferInsert> = {},
): typeof tickets.$inferInsert {
  return {
    requesterId,
    title: "Cannot log in",
    description: "The ERP rejects my password since this morning.",
    idempotencyKey: randomUUID(),
    requestHash: "hash",
    ...overrides,
  };
}

async function newTicket() {
  const requester = await newRequester();
  const [ticket] = await db
    .insert(tickets)
    .values(ticketValues(requester.id))
    .returning();
  return ticket!;
}

const classifiedFacts = {
  classificationState: "classified",
  category: "erp",
  summary: "ERP login rejected",
  blocksWork: true,
  impactScope: "individual",
  classificationSource: "ai",
  priority: "urgent",
  computedPriority: "urgent",
  priorityRule: "erp_blocker",
  team: "it_systems",
} satisfies Partial<typeof tickets.$inferInsert>;

describe("tickets", () => {
  it("rejects a second Ticket with the same idempotency key from the same Requester", async () => {
    const requester = await newRequester();
    await db
      .insert(tickets)
      .values(ticketValues(requester.id, { idempotencyKey: "key-1" }));

    expect(
      await violatedConstraint(
        db
          .insert(tickets)
          .values(ticketValues(requester.id, { idempotencyKey: "key-1" })),
      ),
    ).toBe("tickets_requester_idempotency_key_unique");
  });

  it("accepts the same idempotency key from different Requesters", async () => {
    const [first, second] = [await newRequester(), await newRequester()];
    await db
      .insert(tickets)
      .values([
        ticketValues(first.id, { idempotencyKey: "shared" }),
        ticketValues(second.id, { idempotencyKey: "shared" }),
      ]);
  });

  it("accepts a classified Ticket that carries all its facts", async () => {
    const requester = await newRequester();
    await db
      .insert(tickets)
      .values(ticketValues(requester.id, classifiedFacts));
  });

  it.each([
    "category",
    "summary",
    "blocksWork",
    "impactScope",
    "priority",
    "computedPriority",
    "team",
    "classificationSource",
  ] as const)("rejects a classified Ticket without %s", async (fact) => {
    const requester = await newRequester();
    const values = ticketValues(requester.id, {
      ...classifiedFacts,
      [fact]: null,
      // Keep the override check out of the way when nulling a priority.
      ...(fact === "priority" || fact === "computedPriority"
        ? { priorityOverrideReason: "n/a" }
        : {}),
    });

    expect(await violatedConstraint(db.insert(tickets).values(values))).toBe(
      "tickets_classified_has_facts",
    );
  });

  it("accepts a Priority Override that carries a reason", async () => {
    const requester = await newRequester();
    await db.insert(tickets).values(
      ticketValues(requester.id, {
        ...classifiedFacts,
        priority: "high",
        priorityOverrideReason: "Payroll run is tomorrow, not today",
      }),
    );
  });

  it.each([
    ["no reason", null],
    ["a blank reason", "   "],
  ])("rejects a Priority Override with %s", async (_, reason) => {
    const requester = await newRequester();
    const values = ticketValues(requester.id, {
      ...classifiedFacts,
      priority: "high",
      priorityOverrideReason: reason,
    });

    expect(await violatedConstraint(db.insert(tickets).values(values))).toBe(
      "tickets_override_has_reason",
    );
  });

  it("rejects an override reason when Priority matches the computed one", async () => {
    const requester = await newRequester();
    const values = ticketValues(requester.id, {
      ...classifiedFacts,
      priorityOverrideReason: "No actual change",
    });

    expect(await violatedConstraint(db.insert(tickets).values(values))).toBe(
      "tickets_override_has_reason",
    );
  });

  it.each([
    ["title", "too short", "ab", "tickets_title_length"],
    ["title", "too long", "x".repeat(201), "tickets_title_length"],
    ["description", "too short", "Too short", "tickets_description_length"],
    ["description", "too long", "x".repeat(5001), "tickets_description_length"],
  ] as const)(
    "rejects a %s that is %s",
    async (field, _, value, constraint) => {
      const requester = await newRequester();
      const values = ticketValues(requester.id, { [field]: value });

      expect(await violatedConstraint(db.insert(tickets).values(values))).toBe(
        constraint,
      );
    },
  );

  it("accepts a title and description at their length limits", async () => {
    const requester = await newRequester();
    await db.insert(tickets).values([
      ticketValues(requester.id, { title: "abc", description: "x".repeat(10) }),
      ticketValues(requester.id, {
        title: "x".repeat(200),
        description: "x".repeat(5000),
      }),
    ]);
  });
});

describe("classification_attempts", () => {
  const attempt = (ticketId: string, attemptNo: number) => ({
    ticketId,
    attemptNo,
    kind: "initial" as const,
    outcome: "valid" as const,
    provider: "fake",
    model: "fake",
  });

  it("rejects a repeated attempt number for the same Ticket", async () => {
    const ticket = await newTicket();
    await db.insert(classificationAttempts).values(attempt(ticket.id, 1));

    expect(
      await violatedConstraint(
        db.insert(classificationAttempts).values(attempt(ticket.id, 1)),
      ),
    ).toBe("classification_attempts_ticket_attempt_no_unique");
  });

  it("accepts the same attempt number on different Tickets", async () => {
    const [first, second] = [await newTicket(), await newTicket()];
    await db
      .insert(classificationAttempts)
      .values([attempt(first.id, 1), attempt(second.id, 1)]);
  });
});

function dispatchValues(
  ticketId: string,
  overrides: Partial<typeof dispatches.$inferInsert> = {},
): typeof dispatches.$inferInsert {
  return {
    ticketId,
    sequence: 1,
    category: "erp",
    priority: "urgent",
    team: "it_systems",
    route: "urgent",
    ...overrides,
  };
}

async function newDispatch() {
  const ticket = await newTicket();
  const [dispatch] = await db
    .insert(dispatches)
    .values(dispatchValues(ticket.id))
    .returning();
  return dispatch!;
}

describe("dispatches", () => {
  it.each(["pending", "sent", "unknown"] as const)(
    "rejects a second non-terminal Dispatch while one is %s",
    async (status) => {
      const ticket = await newTicket();
      await db.insert(dispatches).values(dispatchValues(ticket.id, { status }));

      expect(
        await violatedConstraint(
          db
            .insert(dispatches)
            .values(dispatchValues(ticket.id, { sequence: 2 })),
        ),
      ).toBe("dispatches_one_active_per_ticket");
    },
  );

  it.each(["succeeded", "failed"] as const)(
    "accepts a new Dispatch once the earlier one has %s",
    async (status) => {
      const ticket = await newTicket();
      await db.insert(dispatches).values(dispatchValues(ticket.id, { status }));
      await db
        .insert(dispatches)
        .values(dispatchValues(ticket.id, { sequence: 2 }));
    },
  );

  it("rejects a repeated sequence for the same Ticket", async () => {
    const ticket = await newTicket();
    await db
      .insert(dispatches)
      .values(dispatchValues(ticket.id, { status: "succeeded" }));

    expect(
      await violatedConstraint(
        db
          .insert(dispatches)
          .values(dispatchValues(ticket.id, { status: "succeeded" })),
      ),
    ).toBe("dispatches_ticket_sequence_unique");
  });
});

describe("dispatch_attempts", () => {
  const attempt = (dispatchId: string, attemptNo: number) => ({
    dispatchId,
    attemptNo,
    trigger: "auto" as const,
    outcome: "sent" as const,
  });

  it("rejects a repeated attempt number for the same Dispatch", async () => {
    const dispatch = await newDispatch();
    await db.insert(dispatchAttempts).values(attempt(dispatch.id, 1));

    expect(
      await violatedConstraint(
        db.insert(dispatchAttempts).values(attempt(dispatch.id, 1)),
      ),
    ).toBe("dispatch_attempts_dispatch_attempt_no_unique");
  });

  it("accepts the same attempt number on different Dispatches", async () => {
    const [first, second] = [await newDispatch(), await newDispatch()];
    await db
      .insert(dispatchAttempts)
      .values([attempt(first.id, 1), attempt(second.id, 1)]);
  });
});

describe("jobs", () => {
  function jobValues(
    ticketId: string,
    overrides: Partial<typeof jobs.$inferInsert> = {},
  ): typeof jobs.$inferInsert {
    return { kind: "classify", ticketId, ...overrides };
  }

  it.each(["queued", "running"] as const)(
    "rejects a second active job of the same kind for a Ticket while one is %s",
    async (status) => {
      const ticket = await newTicket();
      await db.insert(jobs).values(jobValues(ticket.id, { status }));

      expect(
        await violatedConstraint(db.insert(jobs).values(jobValues(ticket.id))),
      ).toBe("jobs_one_active_per_target");
    },
  );

  it("rejects a second active job for the same Dispatch", async () => {
    const dispatch = await newDispatch();
    const job = jobValues(dispatch.ticketId, {
      kind: "dispatch",
      dispatchId: dispatch.id,
    });
    await db.insert(jobs).values(job);

    expect(await violatedConstraint(db.insert(jobs).values(job))).toBe(
      "jobs_one_active_per_target",
    );
  });

  it.each(["done", "dead"] as const)(
    "accepts a new job once the earlier one is %s",
    async (status) => {
      const ticket = await newTicket();
      await db.insert(jobs).values(jobValues(ticket.id, { status }));
      await db.insert(jobs).values(jobValues(ticket.id));
    },
  );

  it("accepts active jobs of different kinds, or for different Dispatches, on one Ticket", async () => {
    const dispatch = await newDispatch();
    const [older] = await db
      .insert(dispatches)
      .values(
        dispatchValues(dispatch.ticketId, { sequence: 0, status: "failed" }),
      )
      .returning();

    await db.insert(jobs).values([
      jobValues(dispatch.ticketId),
      jobValues(dispatch.ticketId, {
        kind: "reconcile",
        dispatchId: dispatch.id,
      }),
      jobValues(dispatch.ticketId, {
        kind: "reconcile",
        dispatchId: older!.id,
      }),
    ]);
  });
});
