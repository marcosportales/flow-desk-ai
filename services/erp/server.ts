import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createErp } from "./erp.ts";

const port = Number(process.env.PORT ?? 4100);
const dataDir = process.env.DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });

const slowResponseMs = process.env.SLOW_RESPONSE_MS
  ? Number(process.env.SLOW_RESPONSE_MS)
  : undefined;
if (slowResponseMs !== undefined && !(slowResponseMs >= 0)) {
  throw new Error("SLOW_RESPONSE_MS must be a non-negative number");
}

const server = createErp({
  dataFile: join(dataDir, "incidents.json"),
  slowResponseMs,
});

server.listen(port, () => console.log(`erp listening on ${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Slow-mode requests would otherwise hold shutdown open.
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
