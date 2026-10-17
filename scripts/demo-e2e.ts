// End-to-end smoke check: Scenarios A–D (docs/plan/PLAN.md §8) against the
// live compose stack, through the public API and the notifier admin endpoint.
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
  // No .env: fall back to the defaults below.
}

const APP =
  process.env.E2E_APP_URL ??
  `http://localhost:${process.env.APP_HOST_PORT ?? 3000}`;
const NOTIFIER =
  process.env.E2E_NOTIFIER_URL ??
  `http://localhost:${process.env.NOTIFIER_HOST_PORT ?? 4000}`;
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
  const sent = await delivery(dispatch.id);
  assert(
    sent.status === 200,
    "notifier holds the delivery (key = dispatch id)",
  );
  assert(
    String(sent.json.message ?? "").includes("[URGENT]"),
    "delivered message is prefixed [URGENT]",
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
  const retry = await api("POST", `/api/dispatches/${dispatch.id}/retry`);
  assert(retry.status === 202, "manual retry accepted (202)");

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
  compose("stop", "worker");
  const name = `flowdesk-e2e-worker-${RUN}`;
  try {
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

    const manual = await api("POST", `/api/tickets/${id}/classification`, {
      category: "data",
      summary: "Sales report shows wrong quarterly data",
      blocks_work: false,
      impact_scope: "individual",
      reason: "Classified by hand after the AI output was invalid.",
    });
    assert(manual.status === 200, "manual classification accepted");
    const after = await waitForDispatch(id, "succeeded", 60_000);
    assert(
      after.ticket.classificationSource === "human",
      "classification source is human",
    );
    assert(after.ticket.team === "data_team", "Team is data_team");
  } finally {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    compose("start", "worker");
  }
}

async function main() {
  const requesterId = await preflight();
  try {
    await scenarioA(requesterId);
    await scenarioB(requesterId);
    await scenarioC(requesterId);
    if (SKIP_D) log("\nScenario D: skipped (E2E_SKIP_D=1)");
    else await scenarioD(requesterId);
  } finally {
    await setNotifierMode("ok").catch(() => undefined);
  }
  log("\nAll scenarios passed.");
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
