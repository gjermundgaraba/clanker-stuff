import { buildSnapshot } from "../../snapshot.js";
import type { ContextPart } from "../../snapshot.js";

export const fixturePart = (
  label: string,
  body: string,
  estimatedTokens: number,
  overrides: Partial<ContextPart> = {},
): ContextPart => ({ label, body, format: "text", tone: "text", estimatedTokens, ...overrides });

export const fixtureJsonTools = (count: number): ContextPart[] =>
  Array.from({ length: count }, (_, i) =>
    fixturePart(`tool-${i}`, `{"index": ${i}}`, 10, { format: "json" }),
  );

export const fixtureSnapshot = (overrides: Partial<Parameters<typeof buildSnapshot>[0]> = {}) =>
  buildSnapshot({
    prompt: "You are pi.\nFollow the project instructions.",
    tools: [],
    activeTools: [],
    branch: [],
    usage: { tokens: 80, contextWindow: 200, percent: 40 },
    modelLabel: "test/model",
    ...overrides,
  });
