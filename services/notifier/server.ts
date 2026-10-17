import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createNotifier } from "./notifier.ts";

const port = Number(process.env.PORT ?? 4000);
const dataDir = process.env.DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });

const server = createNotifier({
  dataFile: join(dataDir, "deliveries.json"),
  slowResponseMs: process.env.SLOW_RESPONSE_MS
    ? Number(process.env.SLOW_RESPONSE_MS)
    : undefined,
});

server.listen(port, () => console.log(`notifier listening on ${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Slow-mode requests would otherwise hold shutdown open.
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
