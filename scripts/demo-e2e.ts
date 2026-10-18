// End-to-end smoke check: Scenarios A–D (docs/plan/PLAN.md §8) plus E, the
// Requester and Operator path, against the live compose stack, through the
// public API, session cookies and the notifier and ERP admin
// endpoints.
//
//   docker compose up -d && pnpm demo:e2e
//
// Scenario D needs the worker's Classifier to fail, which is worker config,
// so the script swaps the compose worker for a one-off container with
// FAKE_CLASSIFIER_MODE=invalid and restores it afterwards. Set
// E2E_SKIP_D=1 to skip that scenario (e.g. when running against a stack
// that is not managed by docker compose on this machine).
import { execFileSync } from "node:child_process";

try {
  process.loadEnvFile(".env");
} catch {
  console.warn(".env not found in the current directory; using defaults");
}

const APP =
  process.env.E2E_APP_URL ??
  `http://localhost:${process.env.APP_HOST_PORT ?? 3000}`;
const NOTIFIER =
  process.env.E2E_NOTIFIER_URL ??
  `http://localhost:${process.env.NOTIFIER_HOST_PORT ?? 4000}`;
const ERP =
  process.env.E2E_ERP_URL ??
  `http://localhost:${process.env.ERP_HOST_PORT ?? 4100}`;
const API_KEY = process.env.FLOWDESK_API_KEY ?? "change-me";
const SKIP_D = process.env.E2E_SKIP_D === "1";
const RUN = Date.now().toString(36);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(message: string) {
  console.log(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  log(`    ✓ ${message}`);
}

async function request(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const api = (method: string, path: string, body?: unknown, extra = {}) =>
  request(APP, method, path, body, { "x-api-key": API_KEY, ...extra });

// Manual Actions need an Operator session (ADR 0008), so sign in through the
// demo shortcut endpoint and reuse the session cookie. Needs DEMO_SIGN_IN on.
async function signIn(email: string): Promise<Record<string, string>> {
  const res = await fetch(`${APP}/api/demo-sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert(res.status === 200, `signed in as ${email}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { cookie };
}

// Kofi is in it_systems and data_team; Jonas is in service_desk, which owns a
// Ticket in Manual Review until it has a Category.
const DATA_OPERATOR = "kofi.mensah@flowdesk.example";
const REQUESTER = "ana.morales@flowdesk.example";
const SERVICE_DESK_OPERATOR = "jonas.weber@flowdesk.example";

async function setNotifierMode(mode: string) {
  const res = await request(NOTIFIER, "POST", "/admin/mode", { mode });
  assert(res.status === 200, `notifier mode set to ${mode}`);
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(1000);
  }
}

async function createTicket(
  requesterId: string,
  key: string,
  title: string,
  description: string,
) {
  const res = await api(
    "POST",
    "/api/tickets",
    { requesterId, title, description },
    { "idempotency-key": `e2e-${RUN}-${key}` },
  );
  assert(res.status === 202, `ticket "${title}" created (202)`);
  return res.json.ticket.id as string;
}

async function detail(ticketId: string): Promise<Json> {
  const res = await api("GET", `/api/tickets/${ticketId}`);
  if (res.status !== 200)
    throw new Error(`GET ticket ${ticketId}: ${res.status}`);
  return res.json;
}

const eventTypes = (d: Json) =>
  (d.events as Json[]).map((e) => e.type as string);

// True when `expected` appears in `actual` in this order (other events may interleave).
function inOrder(actual: string[], expected: string[]) {
  let i = 0;
  for (const type of actual) if (type === expected[i]) i++;
  return i === expected.length;
}

async function waitForDispatch(
  ticketId: string,
  status: string,
  timeoutMs?: number,
) {
  return waitFor(
    `Dispatch ${status} on ${ticketId}`,
    async () => {
      const d = await detail(ticketId);
      return d.dispatches.some((x: Json) => x.status === status)
        ? d
        : undefined;
    },
    timeoutMs,
  );
}

async function delivery(dispatchId: string) {
  return request(NOTIFIER, "GET", `/deliveries/${dispatchId}`);
}

async function incident(dispatchId: string) {
  return request(ERP, "GET", `/incidents/${dispatchId}`);
}

function compose(...args: string[]) {
  return execFileSync("docker", ["compose", ...args], {
    stdio: "pipe",
  }).toString();
}

async function preflight() {
  log("Preflight");
  const health = await request(APP, "GET", "/api/health");
  assert(health.status === 200, `app healthy at ${APP}`);
  const notifier = await request(NOTIFIER, "GET", "/admin/mode");
  assert(notifier.status === 200, `notifier reachable at ${NOTIFIER}`);
  await setNotifierMode("ok");
  const erp = await request(ERP, "POST", "/admin/mode", { mode: "ok" });
  assert(erp.status === 200, `ERP reachable at ${ERP}`);
  const requesters = await api("GET", "/api/requesters");
  assert(requesters.status === 200, "API key accepted");
  const first = requesters.json.requesters?.[0];
  assert(first, "seed Requesters present");
  return first.id as string;
}

async function scenarioA(requesterId: string) {
  log("\nScenario A: successful workflow");
  const key = "a";
  const title = `SAP unreachable (${RUN})`;
  const description =
    "I haven't been able to access SAP since this morning, and I need to process some invoices.";
  const id = await createTicket(requesterId, key, title, description);

  const replay = await api(
    "POST",
    "/api/tickets",
    { requesterId, title, description },
    { "idempotency-key": `e2e-${RUN}-${key}` },
  );
  assert(
    replay.status === 200 && replay.json.ticket.id === id,
    "same Idempotency-Key returns the same Ticket (200), no duplicate",
  );

  const d = await waitForDispatch(id, "succeeded");
  assert(d.ticket.classificationState === "classified", "Ticket classified");
  assert(d.ticket.category === "erp", "category is erp");
  assert(d.ticket.team === "it_systems", "Team is it_systems");
  assert(d.ticket.priority === "urgent", "Priority is urgent");
  assert(d.ticket.priorityRule === "erp_blocker", "rule erp_blocker matched");
  const dispatch = d.dispatches[0];
  assert(dispatch.route === "urgent", "Dispatch took the urgent Route");
  assert(
    dispatch.attempts.some((a: Json) => a.n8nExecutionId),
    "n8n execution id recorded on the attempt",
  );
  assert(
    inOrder(eventTypes(d), [
      "ticket_created",
      "classified",
      "priority_computed",
      "dispatch_created",
      "dispatch_attempted",
    ]),
    "timeline events are in order",
  );
  // An `erp` Ticket goes to the simulated ERP, not the notifier (ADR 0009).
  const created = await incident(dispatch.id);
  assert(created.status === 200, "ERP holds the incident (key = dispatch id)");
  assert(
    d.ticket.externalReference === created.json.reference,
    `External Reference ${created.json.reference} stored on the Ticket`,
  );
}

async function scenarioB(requesterId: string) {
  log("\nScenario B: urgent request");
  const id = await createTicket(
    requesterId,
    "b",
    `Shared dashboard down (${RUN})`,
    "The shared reporting dashboard is down for the whole company, nobody can work.",
  );
  const d = await waitForDispatch(id, "succeeded");
  assert(d.ticket.priority === "urgent", "Priority is urgent");
  assert(
    d.ticket.priorityRule === "org_wide_blocker",
    "rule org_wide_blocker matched",
  );
  assert(d.dispatches[0].route === "urgent", "Dispatch took the urgent Route");
  assert(
    d.priorityEvaluation?.evaluated?.length > 0,
    "rule evaluation is recorded",
  );
  const sent = await delivery(d.dispatches[0].id);
  assert(
    sent.status === 200 && String(sent.json.message ?? "").includes("[URGENT]"),
    "notifier holds the delivery, prefixed [URGENT]",
  );
}

async function scenarioC(requesterId: string) {
  log("\nScenario C: integration failure and manual retry");
  await setNotifierMode("fail");
  const title = `Sales report wrong (${RUN})`;
  const id = await createTicket(
    requesterId,
    "c",
    title,
    "The monthly sales report shows incorrect data for the last quarter.",
  );
  const failed = await waitForDispatch(id, "failed", 180_000);
  const dispatch = failed.dispatches[0];
  const attemptsBefore = dispatch.attempts.length;
  assert(
    failed.ticket.classificationState === "classified",
    "Ticket stays stored and classified",
  );
  assert(
    attemptsBefore >= 2,
    `failures recorded as attempts (${attemptsBefore})`,
  );
  assert(
    eventTypes(failed).includes("dispatch_failed"),
    "dispatch_failed event on the timeline",
  );

  await setNotifierMode("ok");
  const keyRetry = await api("POST", `/api/dispatches/${dispatch.id}/retry`);
  assert(keyRetry.status === 403, "API key cannot retry a Dispatch (403)");
  const operator = await signIn(DATA_OPERATOR);
  const retry = await request(
    APP,
    "POST",
    `/api/dispatches/${dispatch.id}/retry`,
    undefined,
    operator,
  );
  assert(retry.status === 202, "Operator's manual retry accepted (202)");

  const d = await waitForDispatch(id, "succeeded");
  assert(
    d.dispatches.length === 1 && d.dispatches[0].id === dispatch.id,
    "same dispatch_id reused",
  );
  assert(
    d.dispatches[0].attempts.length > attemptsBefore,
    "retry added a new attempt",
  );
  assert(
    dispatch.attempts.every(
      (a: Json, i: number) => d.dispatches[0].attempts[i]?.id === a.id,
    ),
    "earlier attempts are intact",
  );
  const list = await api("GET", `/api/tickets?q=${encodeURIComponent(title)}`);
  assert(list.json.total === 1, "still exactly one Ticket");
  assert(
    (await delivery(dispatch.id)).status === 200,
    "notifier holds the delivery",
  );
}

async function scenarioD(requesterId: string) {
  log("\nScenario D: invalid AI output");
  const name = `flowdesk-e2e-worker-${RUN}`;
  try {
    compose("stop", "worker");
    compose(
      "run",
      "-d",
      "--no-deps",
      "--name",
      name,
      "-e",
      "FAKE_CLASSIFIER_MODE=invalid",
      "worker",
    );
    // `run -d` returns once the container starts, not once it claims jobs.
    await waitFor("one-off worker healthy", async () => {
      const health = execFileSync("docker", [
        "inspect",
        "-f",
        "{{.State.Health.Status}}",
        name,
      ])
        .toString()
        .trim();
      return health === "healthy";
    });
    const description =
      "The monthly sales report shows incorrect data for the last quarter.";
    const id = await createTicket(
      requesterId,
      "d",
      `Invalid AI output (${RUN})`,
      description,
    );
    const d = await waitFor("Ticket in needs_review", async () => {
      const x = await detail(id);
      return x.ticket.classificationState === "needs_review" ? x : undefined;
    });
    assert(d.ticket.description === description, "original request preserved");
    assert(
      d.dispatches.length === 0,
      "no Dispatch from an invalid classification",
    );
    const outcomes = d.classificationAttempts.map((a: Json) => a.outcome);
    assert(
      outcomes.length === 2 &&
        outcomes.every((o: string) => o === "invalid_output"),
      "initial and repair attempts both invalid",
    );
    assert(
      d.classificationAttempts[0].rawOutput,
      "raw output kept for inspection",
    );

    const facts = {
      category: "data",
      summary: "Sales report shows wrong quarterly data",
      blocks_work: false,
      impact_scope: "individual",
      reason: "Classified by hand after the AI output was invalid.",
    };
    const byKey = await api("POST", `/api/tickets/${id}/classification`, facts);
    assert(byKey.status === 403, "API key cannot classify manually (403)");
    const manual = await request(
      APP,
      "POST",
      `/api/tickets/${id}/classification`,
      facts,
      await signIn(SERVICE_DESK_OPERATOR),
    );
    assert(manual.status === 200, "Operator's manual classification accepted");
    const after = await waitForDispatch(id, "succeeded", 60_000);
    assert(
      after.ticket.classificationSource === "human",
      "classification source is human",
    );
    assert(after.ticket.team === "data_team", "Team is data_team");
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } finally {
      compose("start", "worker");
    }
  }
}

// The two-User path: a Requester raises a Ticket, an Operator of its Team
// takes and resolves it, the Requester is notified and closes it (ADR 0007,
// 0008). Notifications have no API, so the bell in the header is read back.
async function bellText(cookie: Record<string, string>) {
  const res = await fetch(`${APP}/tickets`, { headers: cookie });
  return res.text();
}

async function scenarioE() {
  log("\nScenario E: Requester and Operator, Notification, close");
  const requesters = await api("GET", "/api/requesters");
  const ana = requesters.json.requesters.find(
    (r: Json) => r.name === "Ana Morales",
  );
  assert(ana, "seed Requester Ana Morales present");
  const id = await createTicket(
    ana.id,
    "e",
    `Sales report wrong, two Users (${RUN})`,
    "The monthly sales report shows incorrect data for the last quarter.",
  );
  await waitForDispatch(id, "succeeded");

  const requester = await signIn(REQUESTER);
  const operator = await signIn(DATA_OPERATOR);
  const post = (path: string, body: unknown, who: Record<string, string>) =>
    request(APP, "POST", `/api/tickets/${id}/${path}`, body, who);

  assert(
    (await post("status", { status: "resolved" }, requester)).status === 403,
    "Requester cannot change the Status (403)",
  );
  const take = await post("take", undefined, operator);
  assert(take.status === 200, "Operator takes the Ticket");
  const resolve = await post("status", { status: "resolved" }, operator);
  assert(resolve.status === 200, "Operator resolves the Ticket");

  const bell = await bellText(requester);
  assert(
    /Notifications, [1-9]\d* unread/.test(bell) &&
      bell.includes("Your Ticket was resolved"),
    "Requester sees an unread Notification: Ticket resolved",
  );
  assert(
    !(await bellText(operator)).includes("Your Ticket was resolved"),
    "the Operator does not see the Requester's Notification",
  );

  const stranger = await post(
    "requester-status",
    { response: "close", reason: "fixed" },
    operator,
  );
  assert(stranger.status === 403, "Operator cannot answer for the Requester");
  const close = await post(
    "requester-status",
    { response: "close", reason: "Report is correct now" },
    requester,
  );
  assert(close.status === 200, "Requester closes their own Ticket");
  const d = await detail(id);
  assert(d.ticket.status === "closed", "Ticket is closed");
  assert(
    d.events.some(
      (e: Json) =>
        e.type === "status_changed" &&
        e.data?.to === "closed" &&
        e.data?.reason === "Report is correct now",
    ),
    "closing, with its reason, is on the timeline",
  );
}

async function main() {
  const requesterId = await preflight();
  try {
    await scenarioA(requesterId);
    await scenarioB(requesterId);
    await scenarioC(requesterId);
    if (SKIP_D) log("\nScenario D: skipped (E2E_SKIP_D=1)");
    else await scenarioD(requesterId);
    await scenarioE();
  } finally {
    await setNotifierMode("ok").catch(() => undefined);
  }
  log("\nAll scenarios passed.");
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
