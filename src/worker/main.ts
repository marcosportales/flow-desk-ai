import { writeFile } from "node:fs/promises";

const IDLE_MS = 1000;
// Touched every loop; the compose healthcheck reads its mtime.
const HEARTBEAT_FILE = "/tmp/worker-heartbeat";

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

console.log("worker started");
while (running) {
  // Job claiming arrives with the job queue (SCRUM-10); until then the worker idles.
  await writeFile(HEARTBEAT_FILE, String(Date.now()));
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
}
console.log("worker stopped");
