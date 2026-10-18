import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { POST as postClassification } from "@/app/api/tickets/[id]/classification/route";
import { POST as postRerun } from "@/app/api/tickets/[id]/classification/rerun/route";
import { POST as postOverride } from "@/app/api/tickets/[id]/priority-override/route";
import { POST as postStatus } from "@/app/api/tickets/[id]/status/route";
import { teamMemberships, users } from "@/infra/db/schema";
import { connectTestDb } from "./support/db";
import { dispatchFixtures } from "./support/dispatchFixtures";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/infra/auth/session", () => ({
  getRequestUser: async () => session.user,
}));

const API_KEY = "test-api-key";
const { sql, db } = connectTestDb();
const { classifiedTicket } = dispatchFixtures(db, sql);

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.FLOWDESK_API_KEY = API_KEY;
});
beforeEach(async () => {
  session.user = await newUser(["it_systems"]);
});
afterAll(() => sql.end());

async function newUser(teams: "it_systems"[] = []) {
  const [row] = await db
    .insert(users)
    .values({ name: "U", email: `${randomUUID()}@t.example`, department: "QA" })
    .returning();
  if (teams.length) {
    await db
      .insert(teamMemberships)
      .values(teams.map((team) => ({ userId: row!.id, team })));
  }
  return row!;
}

type Handler = typeof postClassification;
function call(
  handler: Handler,
  id: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return handler(
    new Request("http://localhost/api/tickets/x", {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("manual Ticket action endpoints", () => {
  it("answer 401 without a session and 404 for an unknown Ticket", async () => {
    const valid: [Handler, unknown][] = [
      [
        postClassification,
        {
          category: "erp",
          summary: "s",
          blocks_work: true,
          impact_scope: "team",
          reason: "r",
        },
      ],
      [postRerun, undefined],
      [postOverride, { priority: "low", reason: "r" }],
      [postStatus, { status: "resolved" }],
    ];
    for (const [handler, body] of valid) {
      session.user = null;
      expect((await call(handler, randomUUID(), body)).status).toBe(401);
      session.user = await newUser(["it_systems"]);
      expect((await call(handler, randomUUID(), body)).status).toBe(404);
      expect((await call(handler, "not-a-uuid", body)).status).toBe(404);
    }
  });

  it("rejects a Priority Override without a reason with 422", async () => {
    const ticket = await classifiedTicket();

    const response = await call(postOverride, ticket.id, { priority: "low" });

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_error");
  });

  it("applies an override with a reason", async () => {
    const ticket = await classifiedTicket();

    const response = await call(postOverride, ticket.id, {
      priority: "low",
      reason: "Workaround found",
    });

    expect(response.status).toBe(200);
  });

  it("rejects an illegal status transition with 409", async () => {
    const ticket = await classifiedTicket();

    const response = await call(postStatus, ticket.id, { status: "closed" });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("illegal_transition");
  });

  it("refuses a re-run unless the Ticket needs review (409)", async () => {
    const ticket = await classifiedTicket();
    expect((await call(postRerun, ticket.id)).status).toBe(409);
  });

  it("rejects invalid facts with 422 and a non-JSON body with 422", async () => {
    const ticket = await classifiedTicket();
    expect(
      (await call(postClassification, ticket.id, { category: "erp" })).status,
    ).toBe(422);
    const bad = await postClassification(
      new Request("http://localhost/x", {
        method: "POST",
        body: "nope",
      }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(bad.status).toBe(422);
  });

  it("answers 403 to the API key on every Manual Action route", async () => {
    const ticket = await classifiedTicket();
    session.user = null;
    for (const [handler, body] of [
      [postClassification, { category: "erp" }],
      [postRerun, undefined],
      [postOverride, { priority: "low", reason: "r" }],
      [postStatus, { status: "resolved" }],
    ] as [Handler, unknown][]) {
      const response = await call(handler, ticket.id, body, {
        "X-API-Key": API_KEY,
      });
      expect(response.status).toBe(403);
    }
  });

  it("answers 403 to a Requester-only User and changes nothing", async () => {
    const ticket = await classifiedTicket();
    session.user = { id: ticket.requesterId };

    const response = await call(postStatus, ticket.id, { status: "resolved" });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
    const override = await call(postOverride, ticket.id, {
      priority: "low",
      reason: "r",
    });
    expect(override.status).toBe(403);
  });
});
