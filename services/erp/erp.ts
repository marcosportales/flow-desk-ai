// Simulated ERP: the target system an `erp` Dispatch creates an incident in
// (ADR 0009). Same contract as the notifier: idempotent on the Dispatch id,
// answers "did you receive this id?", and has the same failure modes.
// Zero dependencies so it runs as plain `node server.ts` (type stripping).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export type Incident = {
  // The Dispatch id the incident was created for.
  id: string;
  // What FlowDesk stores as the Ticket's External Reference.
  reference: string;
  ticket_number: string;
  title: string;
  summary: string | null;
  priority: string;
  created_at: string;
};

export const MODES = [
  "ok",
  "fail",
  "fail_once",
  "timeout",
  "accept_then_drop_callback",
] as const;
export type Mode = (typeof MODES)[number];

export type ErpOptions = {
  // JSON file holding every incident, keyed by Idempotency-Key.
  dataFile: string;
  // How long the slow modes hold a request: longer than n8n's 10s timeout.
  slowResponseMs?: number;
};

export function createErp(options: ErpOptions) {
  const incidents = load(options.dataFile);
  // Not persisted: a restart is back to "ok".
  let mode: Mode = "ok";
  const slowResponseMs = options.slowResponseMs ?? 15_000;

  function save() {
    const tmp = `${options.dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(incidents), null, 2));
    renameSync(tmp, options.dataFile);
  }

  async function postIncident(req: IncomingMessage, res: ServerResponse) {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.trim() === "") {
      return sendError(
        res,
        400,
        "missing_idempotency_key",
        "Idempotency-Key header is required",
      );
    }
    const body = await readJson(req);
    // Checked after the body is read so that the check and the store below
    // run without an await between them: a concurrent request with the same
    // key cannot slip in and create a second incident.
    const existing = incidents.get(key);
    if (existing) return sendJson(res, 200, existing);
    if (
      !isRecord(body) ||
      typeof body.ticket_number !== "string" ||
      typeof body.title !== "string" ||
      typeof body.priority !== "string" ||
      !(typeof body.summary === "string" || body.summary == null)
    ) {
      return sendError(
        res,
        400,
        "invalid_body",
        "Body must be { ticket_number: string, title: string, summary: string | null, priority: string }",
      );
    }
    if (mode === "fail" || mode === "fail_once") {
      if (mode === "fail_once") mode = "ok";
      return sendError(res, 500, "simulated_failure", "Simulated ERP failure");
    }
    if (mode === "timeout") {
      await sleep(slowResponseMs);
      return sendError(res, 504, "simulated_timeout", "Simulated timeout");
    }
    const incident: Incident = {
      id: key,
      // Incidents are never removed, so the count gives the next number.
      reference: `INC-${String(incidents.size + 1).padStart(6, "0")}`,
      ticket_number: body.ticket_number,
      title: body.title,
      summary: body.summary ?? null,
      priority: body.priority,
      created_at: new Date().toISOString(),
    };
    incidents.set(key, incident);
    save();
    // The incident exists, but the answer arrives after the caller gave up:
    // the lost-response case that Reconciliation exists for.
    if (mode === "accept_then_drop_callback") await sleep(slowResponseMs);
    sendJson(res, 201, incident);
  }

  async function postMode(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    const requested = isRecord(body) ? body.mode : undefined;
    if (!isMode(requested)) {
      return sendError(
        res,
        400,
        "invalid_mode",
        `mode must be one of: ${MODES.join(", ")}`,
      );
    }
    mode = requested;
    console.log(`erp mode: ${mode}`);
    sendJson(res, 200, { mode });
  }

  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://erp");
    try {
      if (req.method === "GET" && pathname === "/health") {
        return sendJson(res, 200, { status: "ok" });
      }
      if (req.method === "GET" && pathname === "/") {
        return sendHtml(res, renderPage([...incidents.values()]));
      }
      if (req.method === "POST" && pathname === "/incidents") {
        return await postIncident(req, res);
      }
      if (req.method === "GET" && pathname === "/admin/mode") {
        return sendJson(res, 200, { mode });
      }
      if (req.method === "POST" && pathname === "/admin/mode") {
        return await postMode(req, res);
      }
      const lookup = /^\/incidents\/([^/]+)$/.exec(pathname);
      if (req.method === "GET" && lookup) {
        const incident = incidents.get(safeDecode(lookup[1]!));
        return incident
          ? sendJson(res, 200, incident)
          : sendError(res, 404, "not_found", "Incident not found");
      }
      sendError(res, 404, "not_found", "Not found");
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendError(res, 500, "internal", "Internal error");
    }
  });
}

function load(dataFile: string): Map<string, Incident> {
  if (!existsSync(dataFile)) return new Map();
  const stored = JSON.parse(readFileSync(dataFile, "utf8")) as Record<
    string,
    Incident
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

function isMode(value: unknown): value is Mode {
  return MODES.includes(value as Mode);
}

// A malformed escape cannot name a stored incident, so it is a plain miss.
function safeDecode(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
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

function renderPage(incidents: Incident[]) {
  const rows = incidents
    .toSorted((a, b) => b.created_at.localeCompare(a.created_at))
    .map(
      (i) =>
        `<tr><td><strong>${escapeHtml(i.reference)}</strong></td><td>${escapeHtml(i.created_at)}</td>` +
        `<td>${escapeHtml(i.ticket_number)}</td><td>${escapeHtml(i.title)}</td>` +
        `<td>${escapeHtml(i.priority)}</td><td><code>${escapeHtml(i.id)}</code></td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>ERP: incidents</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; }
</style>
</head>
<body>
<h1>ERP incidents (${incidents.length})</h1>
<table>
<thead><tr><th>Reference</th><th>Created</th><th>Ticket</th><th>Title</th><th>Priority</th><th>Dispatch id</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6">No incidents yet.</td></tr>'}
</tbody>
</table>
</body>
</html>
`;
}
