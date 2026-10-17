import { mkdtemp, rm } from "node:fs/promises";
import { request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNotifier } from "../services/notifier/notifier";

let dir: string;
let servers: Server[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "notifier-"));
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
  const server = createNotifier({
    dataFile: join(dir, "deliveries.json"),
    slowResponseMs: options.slowResponseMs ?? 200,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function deliver(
  base: string,
  key: string | null,
  body: unknown = { channel: "#it-systems", message: "ERP is down" },
  signal?: AbortSignal,
) {
  return fetch(`${base}/deliveries`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { "idempotency-key": key }),
    },
    body: JSON.stringify(body),
  });
}

describe("notifier deliveries", () => {
  it("stores a delivery once when the same Idempotency-Key is sent twice", async () => {
    const base = await start();

    const first = await deliver(base, "d-1");
    const replay = await deliver(base, "d-1", {
      channel: "#other",
      message: "different body",
    });

    expect(first.status).toBe(201);
    const stored = await first.json();
    expect(stored).toMatchObject({
      id: "d-1",
      channel: "#it-systems",
      message: "ERP is down",
    });
    expect(typeof stored.received_at).toBe("string");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(stored);

    const page = await (await fetch(`${base}/`)).text();
    expect(page.match(/ERP is down/g)).toHaveLength(1);
    expect(page).not.toContain("different body");
  });

  it("stores a delivery once when the same key arrives while another is in flight", async () => {
    const base = await start();

    // The slow request sends its headers now and its body only after a
    // second request with the same key has been stored.
    const slow = request(`${base}/deliveries`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "d-race",
      },
    });
    slow.flushHeaders();
    const slowResponse = new Promise<IncomingMessage>((resolve) =>
      slow.on("response", resolve),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fast = await deliver(base, "d-race");
    slow.end(JSON.stringify({ channel: "#late", message: "late body" }));
    const late = await slowResponse;

    expect(fast.status).toBe(201);
    expect(late.statusCode).toBe(200);
    expect(await (await fetch(`${base}/deliveries/d-race`)).json()).toEqual(
      await fast.json(),
    );
  });

  it("rejects a delivery without an Idempotency-Key", async () => {
    const base = await start();

    const res = await deliver(base, null);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "missing_idempotency_key" },
    });
  });

  it("looks up a stored delivery by id, across a restart", async () => {
    const first = await start();
    const stored = await (await deliver(first, "d-2")).json();

    const restarted = await start();
    const found = await fetch(`${restarted}/deliveries/d-2`);
    const missing = await fetch(`${restarted}/deliveries/nope`);

    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(stored);
    expect(missing.status).toBe(404);
    expect((await fetch(`${restarted}/deliveries/%E0%A4%A`)).status).toBe(404);
  });
});

function setMode(base: string, mode: string) {
  return fetch(`${base}/admin/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

describe("notifier failure modes", () => {
  it("rejects an unknown mode", async () => {
    const base = await start();

    const res = await setMode(base, "explode");

    expect(res.status).toBe(400);
  });

  it("fail: every delivery fails and nothing is stored", async () => {
    const base = await start();
    expect((await setMode(base, "fail")).status).toBe(200);

    const first = await deliver(base, "d-3");
    const second = await deliver(base, "d-3");

    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect((await fetch(`${base}/deliveries/d-3`)).status).toBe(404);
  });

  it("fail_once: the next delivery fails, then the notifier is back to ok", async () => {
    const base = await start();
    await setMode(base, "fail_once");

    const failed = await deliver(base, "d-4");
    const retried = await deliver(base, "d-4");

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(201);
    expect(await (await fetch(`${base}/admin/mode`)).json()).toEqual({
      mode: "ok",
    });
  });

  // The client gives up before the notifier answers, like n8n's HTTP timeout.
  const clientTimeout = () => AbortSignal.timeout(50);

  it("timeout: the client times out and nothing is stored", async () => {
    const base = await start({ slowResponseMs: 150 });
    await setMode(base, "timeout");

    await expect(
      deliver(base, "d-5", undefined, clientTimeout()),
    ).rejects.toThrow();
    const patient = await deliver(base, "d-5");

    expect(patient.status).toBe(504);
    expect((await fetch(`${base}/deliveries/d-5`)).status).toBe(404);
  });

  it("accept_then_drop_callback: the client times out but the delivery is stored once", async () => {
    const base = await start({ slowResponseMs: 150 });
    await setMode(base, "accept_then_drop_callback");

    await expect(
      deliver(base, "d-6", undefined, clientTimeout()),
    ).rejects.toThrow();

    const found = await fetch(`${base}/deliveries/d-6`);
    expect(found.status).toBe(200);
    const replay = await deliver(base, "d-6");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await found.json());
  });
});
