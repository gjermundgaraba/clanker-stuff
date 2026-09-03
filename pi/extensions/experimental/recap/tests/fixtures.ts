import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Message, StopReason } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onTestFinished, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";

type CompleteModel = ExtensionContext["modelRegistry"]["complete"];
type CompletionMock = CompleteModel & Mock<CompleteModel>;

export const completionMock = (implementation: CompleteModel): CompletionMock => {
  const mock = vi.fn<CompleteModel>(implementation);
  // SAFETY: Vitest forwards calls unchanged; Mock only loses the generic model/options correlation in its callable type.
  return mock as CompletionMock;
};

export const userMessage = (content: string): Message => ({
  content,
  role: "user",
  timestamp: Date.now(),
});

export const appendTurn = (
  session: SessionManager,
  number: number,
  stopReason: StopReason = "stop",
): void => {
  session.appendMessage(userMessage(`request ${number}`));
  session.appendMessage(
    fauxAssistantMessage(`answer ${number}`, {
      errorMessage: stopReason === "error" || stopReason === "aborted" ? "failed" : undefined,
      stopReason,
    }),
  );
};

export const sessionWithTurns = (count: number): SessionManager => {
  const session = SessionManager.inMemory();
  for (let number = 1; number <= count; number += 1) {
    appendTurn(session, number);
  }
  return session;
};

export const createRecapConfigFile = async (
  modelId = "small",
): Promise<{
  configPath: string;
  directory: string;
}> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recap-test-"));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const configPath = path.join(directory, "recap.json");
  await writeFile(
    configPath,
    JSON.stringify({ model: { id: modelId, provider: "cheap" } }),
    "utf-8",
  );
  return { configPath, directory };
};

export const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
