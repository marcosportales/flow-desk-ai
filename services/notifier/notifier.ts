// Simulated notification service: the external target n8n delivers to.
// Zero dependencies so it runs as plain `node server.ts` (type stripping).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export type Delivery = {
  id: string;
  channel: string;
  message: string;
  received_at: string;
};

export const MODES = [
  "ok",
  "fail",
  "fail_once",
  "timeout",
  "accept_then_drop_callback",
] as const;
export type Mode = (typeof MODES)[number];

export type NotifierOptions = {
  // JSON file holding every stored delivery, keyed by Idempotency-Key.
  dataFile: string;
  // How long the slow modes hold a request: longer than n8n's 10s timeout.
  slowResponseMs?: number;
};

export function createNotifier(options: NotifierOptions) {
  const deliveries = load(options.dataFile);
  // Not persisted: a restart is back to "ok".
  let mode: Mode = "ok";
  const slowResponseMs = options.slowResponseMs ?? 15_000;

  function save() {
    const tmp = `${options.dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(deliveries), null, 2));
    renameSync(tmp, options.dataFile);
  }

  async function postDelivery(req: IncomingMessage, res: ServerResponse) {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.trim() === "") {
      return sendError(
        res,
        400,
        "missing_idempotency_key",
        "Idempotency-Key header is required",
      );
    }
    const existing = deliveries.get(key);
    if (existing) return sendJson(res, 200, existing);

    const body = await readJson(req);
    if (
      !isRecord(body) ||
      typeof body.channel !== "string" ||
      typeof body.message !== "string"
    ) {
      return sendError(
        res,
        400,
        "invalid_body",
        "Body must be { channel: string, message: string }",
      );
    }
    if (mode === "fail" || mode === "fail_once") {
      if (mode === "fail_once") mode = "ok";
      return sendError(
        res,
        500,
        "simulated_failure",
        "Simulated delivery failure",
      );
    }
    if (mode === "timeout") {
      await sleep(slowResponseMs);
      return sendError(res, 504, "simulated_timeout", "Simulated timeout");
    }
    const delivery: Delivery = {
      id: key,
      channel: body.channel,
      message: body.message,
      received_at: new Date().toISOString(),
    };
    deliveries.set(key, delivery);
    save();
    // The effect happened, but the answer arrives after the caller gave up:
    // the lost-response case that Reconciliation exists for.
    if (mode === "accept_then_drop_callback") await sleep(slowResponseMs);
    sendJson(res, 201, delivery);
  }

  async function postMode(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    const requested = isRecord(body) ? body.mode : undefined;
    if (!MODES.includes(requested as Mode)) {
      return sendError(
        res,
        400,
        "invalid_mode",
        `mode must be one of: ${MODES.join(", ")}`,
      );
    }
    mode = requested as Mode;
    console.log(`notifier mode: ${mode}`);
    sendJson(res, 200, { mode });
  }

  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://notifier");
    try {
      if (req.method === "GET" && pathname === "/health") {
        return sendJson(res, 200, { status: "ok" });
      }
      if (req.method === "GET" && pathname === "/") {
        return sendHtml(res, renderPage([...deliveries.values()]));
      }
      if (req.method === "POST" && pathname === "/deliveries") {
        return await postDelivery(req, res);
      }
      if (req.method === "GET" && pathname === "/admin/mode") {
        return sendJson(res, 200, { mode });
      }
      if (req.method === "POST" && pathname === "/admin/mode") {
        return await postMode(req, res);
      }
      const lookup = /^\/deliveries\/([^/]+)$/.exec(pathname);
      if (req.method === "GET" && lookup) {
        const delivery = deliveries.get(decodeURIComponent(lookup[1]!));
        return delivery
          ? sendJson(res, 200, delivery)
          : sendError(res, 404, "not_found", "Delivery not found");
      }
      sendError(res, 404, "not_found", "Not found");
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendError(res, 500, "internal", "Internal error");
    }
  });
}

function load(dataFile: string): Map<string, Delivery> {
  if (!existsSync(dataFile)) return new Map();
  const stored = JSON.parse(readFileSync(dataFile, "utf8")) as Record<
    string,
    Delivery
  >;
  return new Map(Object.entries(stored));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
) {
  sendJson(res, status, { error: { code, message } });
}

function sendHtml(res: ServerResponse, html: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(deliveries: Delivery[]) {
  const rows = deliveries
    .toSorted((a, b) => b.received_at.localeCompare(a.received_at))
    .map(
      (d) =>
        `<tr><td>${escapeHtml(d.received_at)}</td><td>${escapeHtml(d.channel)}</td>` +
        `<td>${escapeHtml(d.message)}</td><td><code>${escapeHtml(d.id)}</code></td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>Notifier: received messages</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; }
</style>
</head>
<body>
<h1>Received messages (${deliveries.length})</h1>
<table>
<thead><tr><th>Received</th><th>Channel</th><th>Message</th><th>Delivery id</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="4">No messages yet.</td></tr>'}
</tbody>
</table>
</body>
</html>
`;
}
