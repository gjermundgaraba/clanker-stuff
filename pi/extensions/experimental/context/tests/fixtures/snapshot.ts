import { SessionManager } from "@earendil-works/pi-coding-agent";

import { buildSnapshot } from "../../snapshot.js";
import type { ContextPart, ContextMessagePart } from "../../snapshot.js";

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

export const fixtureMessage = (
  label: string,
  body: string,
  estimatedTokens: number,
): ContextMessagePart => ({
  ...fixturePart(label, body, estimatedTokens),
  sourceEntryId: label,
});

/** A branch whose first request recorded `prompt`, as Pi persists it. */
export const recordedBranch = (prompt: string) => {
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "system", content: prompt, timestamp: 0 });

  return session.getBranch();
};

export const fixtureSnapshot = ({
  prompt = "You are pi.\nFollow the project instructions.",
  ...overrides
}: Partial<Parameters<typeof buildSnapshot>[0]> & { prompt?: string } = {}) =>
  buildSnapshot({
    pendingPrompt: prompt,
    branch: recordedBranch(prompt),
    usage: { tokens: 80, contextWindow: 200, percent: 40 },
    modelLabel: "test/model",
    ...overrides,
  });
