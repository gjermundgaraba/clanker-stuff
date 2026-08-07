import type { Model } from "@earendil-works/pi-ai";

export const createModel = (id: string, grammar = false) =>
  ({
    api: "openai-responses",
    baseUrl: "https://example.com",
    compat: grammar ? { supportsOpenAIGrammarTools: true } : undefined,
    contextWindow: 100_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text"],
    maxTokens: 10_000,
    name: id,
    provider: "test",
    reasoning: true,
  }) satisfies Model<"openai-responses">;
