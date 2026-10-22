// Reads the public URL of the `power-automate` profile's quick tunnel and
// writes FLOWDESK_CALLBACK_URL (its /callback) to .env.
//
//   docker compose --profile power-automate up -d && pnpm tunnel:url
//
// The flow derives the notifier and ERP URLs from the origin of
// `callback_url` in each event, so only this one value changes per tunnel.
// FLOWDESK_CALLBACK_URL is also n8n's callback: run this only when the stack
// dispatches to Power Automate.
import { readFileSync, writeFileSync } from "node:fs";
import { callbackUrlFromHostname, setEnvValue } from "./tunnelEnv";

const ENV_FILE = ".env";

try {
  process.loadEnvFile(ENV_FILE);
} catch {
  console.warn(".env not found in the current directory; using defaults");
}

const METRICS_URL = `http://localhost:${process.env.TUNNEL_METRICS_HOST_PORT ?? 2000}`;
const TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// cloudflared serves {"hostname": "..."} once the quick tunnel is up.
async function tunnelHostname(): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${METRICS_URL}/quicktunnel`);
      if (res.ok) {
        const { hostname } = (await res.json()) as { hostname?: string };
        if (hostname) return hostname;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(1000);
  }
  throw new Error(
    `No quick tunnel at ${METRICS_URL}/quicktunnel after ${TIMEOUT_MS / 1000}s. ` +
      "Is `docker compose --profile power-automate up -d` running?",
  );
}

const callbackUrl = callbackUrlFromHostname(await tunnelHostname());
let env = "";
try {
  env = readFileSync(ENV_FILE, "utf8");
} catch {
  // Written from scratch below.
}
writeFileSync(ENV_FILE, setEnvValue(env, "FLOWDESK_CALLBACK_URL", callbackUrl));

console.log(`FLOWDESK_CALLBACK_URL=${callbackUrl} written to ${ENV_FILE}`);
console.log("Recreate the worker to pick it up: docker compose up -d worker");
