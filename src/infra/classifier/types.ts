// What the worker needs from an AI provider. A Classifier returns the model's
// raw text; parsing and validation belong to the caller (ADR 0003), because
// the output is never trusted whatever the provider promises.

export type ClassifierInput = {
  title: string;
  description: string;
  // Set on the one repair call after invalid output.
  repair?: { previousOutput: string; error: string };
};

export type ClassifierOutput = { rawOutput: string };

export interface Classifier {
  readonly provider: string;
  readonly model: string;
  classify(input: ClassifierInput): Promise<ClassifierOutput>;
}

// Timeout, 5xx, 429, network: the provider could not answer. The job retries.
export class ClassifierProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierProviderError";
  }
}
