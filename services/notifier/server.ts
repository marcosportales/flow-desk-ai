// Simulated notification service. Deliveries and failure modes arrive with SCRUM-12.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4000);

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ error: { code: "not_found", message: "Not found" } }),
  );
});

server.listen(port, () => console.log(`notifier listening on ${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
