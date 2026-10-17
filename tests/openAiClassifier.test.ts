import { describe, expect, it } from "vitest";
import { OpenAiCompatibleClassifier } from "@/infra/classifier/openai";
import { ClassifierProviderError } from "@/infra/classifier/types";

type Call = { url: string; headers: Headers; body: Record<string, unknown> };

// A scripted provider: each response is consumed in order.
function stubFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchStub };
}

const completion = (content: string | null) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
  });
const status = (code: number, body = "nope") =>
  new Response(body, { status: code });

function make(responses: Array<Response | Error>) {
  const { calls, fetchStub } = stubFetch(responses);
  const classifier = new OpenAiCompatibleClassifier({
    baseUrl: "https://llm.example/v1/",
    apiKey: "sk-test",
    model: "test-model",
    fetch: fetchStub,
  });
  return { calls, classifier };
}

const input = { title: "SAP down", description: "Cannot reach SAP at all." };

describe("OpenAiCompatibleClassifier", () => {
  it("posts a chat completion with the key and model and returns the content", async () => {
    const { calls, classifier } = make([completion('{"a":1}')]);

    const out = await classifier.classify(input);

    expect(out.rawOutput).toBe('{"a":1}');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://llm.example/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-test");
    expect(calls[0]!.body.model).toBe("test-model");
    expect(JSON.stringify(calls[0]!.body.messages)).toContain(
      "Cannot reach SAP at all.",
    );
  });

  it("tries json_schema first, then json_object, then plain, and remembers what worked", async () => {
    const { calls, classifier } = make([
      status(400),
      status(422),
      completion("```json\n{}\n```"),
      completion("{}"),
    ]);

    const first = await classifier.classify(input);
    await classifier.classify(input);

    expect(first.rawOutput).toBe("```json\n{}\n```");
    const formats = calls.map(
      (c) => (c.body.response_format as { type?: string } | undefined)?.type,
    );
    expect(formats).toEqual([
      "json_schema",
      "json_object",
      undefined,
      undefined,
    ]);
  });

  it("includes the previous output and error in a repair call", async () => {
    const { calls, classifier } = make([completion("{}")]);

    await classifier.classify({
      ...input,
      repair: { previousOutput: "garbage-output", error: "category: invalid" },
    });

    const sent = JSON.stringify(calls[0]!.body.messages);
    expect(sent).toContain("garbage-output");
    expect(sent).toContain("category: invalid");
  });

  it.each([
    ["a 500", status(500)],
    ["a 429", status(429)],
    ["a network error", new TypeError("fetch failed")],
    ["a timeout", new DOMException("timed out", "TimeoutError")],
    ["an unauthorized key", status(401)],
    ["an empty completion", completion(null)],
    ["a non-JSON body", new Response("<html>", { status: 200 })],
  ])("throws a provider error on %s", async (_name, response) => {
    const { classifier } = make([response]);
    await expect(classifier.classify(input)).rejects.toBeInstanceOf(
      ClassifierProviderError,
    );
  });
});
