import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Message,
  SimpleStreamOptions,
  StopReason,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onTestFinished, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";

import type { RecapConfig } from "../config.js";

type StreamModel = ExtensionContext["modelRegistry"]["streamSimple"];

export type ResponseStep = (
  context: Parameters<StreamModel>[1],
  options: SimpleStreamOptions | undefined,
) => AssistantMessage | Promise<AssistantMessage>;

/**
 * Mocks registry streaming with queued responses, one per request. Recap only
 * awaits `.result()`, so each step settles the stream's result directly. Unlike
 * the faux provider it keeps each message's usage and settles within a few
 * microtasks, which the overflow and cancellation tests rely on. A thrown error
 * becomes an error result.
 */
export const queuedStream = (...responses: ResponseStep[]): Mock<StreamModel> =>
  vi.fn<StreamModel>((_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const step = responses.shift();

    void (async () => {
      try {
        if (step === undefined) {
          throw new Error("No more test responses queued");
        }

        stream.end(await step(context, options));
      } catch (error) {
        stream.end(
          fauxAssistantMessage("", {
            errorMessage: error instanceof Error ? error.message : String(error),
            stopReason: "error",
          }),
        );
      }
    })();

    return stream;
  });

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
      ...(stopReason === "error" || stopReason === "aborted" ? { errorMessage: "failed" } : {}),
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
  config: { model: RecapConfig["model"]; thinking?: RecapConfig["thinking"] } = {
    model: { id: "small", provider: "cheap" },
  },
): Promise<{
  configPath: string;
  directory: string;
}> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recap-test-"));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const configPath = path.join(directory, "recap.json");
  await writeFile(configPath, JSON.stringify(config), "utf-8");

  return { configPath, directory };
};

export const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
