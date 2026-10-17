import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type StubRequest = {
  headers: IncomingMessage["headers"];
  body: string;
};

// Answers like n8n's webhook node: records each request and replies with the
// status `respond` picks. `onRequest` is the rest of the workflow; it starts
// as the request arrives, and `replyAfterMs` holds the reply back so its
// callback can overtake the 202.
export async function startN8nStub(
  options: {
    respond?: (request: StubRequest) => number;
    onRequest?: (request: StubRequest) => Promise<void>;
    replyAfterMs?: number;
  } = {},
) {
  const requests: StubRequest[] = [];
  const pending: Promise<void>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = {
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    };
    requests.push(request);
    if (options.onRequest) pending.push(options.onRequest(request));
    await new Promise((resolve) =>
      setTimeout(resolve, options.replyAfterMs ?? 0),
    );
    res.writeHead(options.respond?.(request) ?? 202).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhook/flowdesk-dispatch`,
    requests,
    // Waits for every `onRequest` started so far.
    settled: () => Promise.all(pending),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
