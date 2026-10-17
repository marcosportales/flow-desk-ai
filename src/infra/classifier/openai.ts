import { z } from "zod";
import { Classification } from "@/domain/classification";
import { buildMessages } from "./prompt";
import {
  type Classifier,
  type ClassifierInput,
  type ClassifierOutput,
  ClassifierProviderError,
} from "./types";

export const REQUEST_TIMEOUT_MS = 20_000;

type ResponseFormat = Record<string, unknown> | undefined;

// Most to least structured. Providers differ in what they accept, so a 400/422
// steps down; the output is Zod-validated by the caller whichever one worked.
const responseFormats: ResponseFormat[] = [
  {
    type: "json_schema",
    json_schema: {
      name: "classification",
      strict: true,
      schema: z.toJSONSchema(Classification),
    },
  },
  { type: "json_object" },
  undefined,
];

const completionBody = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
});

type Options = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
};

export class OpenAiCompatibleClassifier implements Classifier {
  readonly provider = "openai_compatible";
  readonly model: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetch: typeof fetch;
  // Index into responseFormats; advances when the provider rejects one.
  private formatIndex = 0;

  constructor(options: Options) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.fetch = options.fetch ?? fetch;
  }

  async classify(input: ClassifierInput): Promise<ClassifierOutput> {
    for (;;) {
      const response = await this.post(
        input,
        responseFormats[this.formatIndex],
      );
      const unsupported = response.status === 400 || response.status === 422;
      if (unsupported && this.formatIndex < responseFormats.length - 1) {
        this.formatIndex += 1;
        console.warn(
          `classifier: provider rejected response_format (${response.status}); falling back to ${responseFormats[this.formatIndex]?.type ?? "plain text"}`,
        );
        continue;
      }
      return { rawOutput: await this.contentOf(response) };
    }
  }

  private async post(input: ClassifierInput, responseFormat: ResponseFormat) {
    try {
      return await this.fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: buildMessages(input),
          ...(responseFormat && { response_format: responseFormat }),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ClassifierProviderError(`request failed: ${reason}`);
    }
  }

  private async contentOf(response: Response): Promise<string> {
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new ClassifierProviderError(
        `provider answered ${response.status}: ${body}`,
      );
    }
    const parsed = completionBody.safeParse(
      await response.json().catch(() => null),
    );
    const content = parsed.success
      ? parsed.data.choices[0]!.message.content
      : null;
    if (!content) {
      throw new ClassifierProviderError(
        "provider returned no completion content",
      );
    }
    return content;
  }
}
