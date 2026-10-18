import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createErp } from "../services/erp/erp";

let dir: string;
let servers: Server[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "erp-"));
});

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  servers = [];
  await rm(dir, { recursive: true, force: true });
});

async function start(options: { slowResponseMs?: number } = {}) {
  const server = createErp({
    dataFile: join(dir, "incidents.json"),
    slowResponseMs: options.slowResponseMs ?? 200,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const incident = {
  ticket_number: "FD-000042",
  title: "SAP is down",
  summary: "Problem using the ERP system",
  priority: "urgent",
};

function createIncident(
  base: string,
  key: string | null,
  body: unknown = incident,
  signal?: AbortSignal,
) {
  return fetch(`${base}/incidents`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { "idempotency-key": key }),
    },
    body: JSON.stringify(body),
  });
}

function setMode(base: string, mode: string) {
  return fetch(`${base}/admin/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

describe("ERP incidents", () => {
  it("creates one incident with a reference per Idempotency-Key", async () => {
    const base = await start();

    const first = await createIncident(base, "d-1");
    const replay = await createIncident(base, "d-1", {
      ...incident,
      title: "different title",
    });
    const second = await createIncident(base, "d-2");

    expect(first.status).toBe(201);
    const stored = await first.json();
    expect(stored).toMatchObject({
      id: "d-1",
      reference: "INC-000001",
      ticket_number: "FD-000042",
      title: "SAP is down",
      priority: "urgent",
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(stored);
    expect((await second.json()).reference).toBe("INC-000002");

    const page = await (await fetch(`${base}/`)).text();
    expect(page.match(/INC-000001/g)).toHaveLength(1);
    expect(page).not.toContain("different title");
  });

  it("rejects an incident without an Idempotency-Key or with a malformed body", async () => {
    const base = await start();

    const noKey = await createIncident(base, null);
    const badBody = await createIncident(base, "d-3", { title: 1 });

    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({
      error: { code: "missing_idempotency_key" },
    });
    expect(badBody.status).toBe(400);
    expect((await fetch(`${base}/incidents/d-3`)).status).toBe(404);
  });

  it("answers whether it holds an incident for an id, across a restart", async () => {
    const first = await start();
    const stored = await (await createIncident(first, "d-4")).json();

    const restarted = await start();
    const found = await fetch(`${restarted}/incidents/d-4`);
    const missing = await fetch(`${restarted}/incidents/nope`);
    const next = await (await createIncident(restarted, "d-5")).json();

    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(stored);
    expect(missing.status).toBe(404);
    expect(next.reference).toBe("INC-000002");
  });
});

describe("ERP failure modes", () => {
  it("fail: every request fails and no incident is created", async () => {
    const base = await start();
    expect((await setMode(base, "fail")).status).toBe(200);

    expect((await createIncident(base, "d-6")).status).toBe(500);
    expect((await fetch(`${base}/incidents/d-6`)).status).toBe(404);
  });

  it("fail_once: the next request fails, then the ERP is back to ok", async () => {
    const base = await start();
    await setMode(base, "fail_once");

    expect((await createIncident(base, "d-7")).status).toBe(500);
    expect((await createIncident(base, "d-7")).status).toBe(201);
  });

  const clientTimeout = () => AbortSignal.timeout(50);

  it("timeout: the client times out and no incident is created", async () => {
    const base = await start({ slowResponseMs: 150 });
    await setMode(base, "timeout");

    await expect(
      createIncident(base, "d-8", undefined, clientTimeout()),
    ).rejects.toThrow();
    expect((await createIncident(base, "d-8")).status).toBe(504);
    expect((await fetch(`${base}/incidents/d-8`)).status).toBe(404);
  });

  it("accept_then_drop_callback: the client times out but the incident exists once", async () => {
    const base = await start({ slowResponseMs: 150 });
    await setMode(base, "accept_then_drop_callback");

    await expect(
      createIncident(base, "d-9", undefined, clientTimeout()),
    ).rejects.toThrow();

    const found = await fetch(`${base}/incidents/d-9`);
    expect(found.status).toBe(200);
    const replay = await createIncident(base, "d-9");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await found.json());
  });
});
