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
import { ROLLING_PAIRS } from "../font.js";

type StreamModel = ExtensionContext["modelRegistry"]["streamSimple"];

export type ResponseStep = (
  context: Parameters<StreamModel>[1],
  options: SimpleStreamOptions | undefined,
) => AssistantMessage | Promise<AssistantMessage>;

/**
 * Mocks registry streaming with queued responses, one per request. Recap only
 * awaits `.result()`, so each step settles the stream's result directly.
 * Preserves reported usage, converts thrown errors to error results, and ends
 * with an aborted result when the request's signal aborts, as Pi's providers do.
 */
export const queuedStream = (...responses: ResponseStep[]): Mock<StreamModel> =>
  vi.fn<StreamModel>((_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const step = responses.shift();
    const aborted = Promise.withResolvers<AssistantMessage>();

    options?.signal?.addEventListener(
      "abort",
      () => aborted.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
      { once: true },
    );

    void (async () => {
      try {
        if (step === undefined) {
          throw new Error("No more test responses queued");
        }

        stream.end(await Promise.race([step(context, options), aborted.promise]));
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

/** A provider that ignores cancellation: its stream never ends, even after the signal aborts. */
export const unresponsiveStream = (): Mock<StreamModel> =>
  vi.fn<StreamModel>(() => createAssistantMessageEventStream());

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
  const configPath = path.join(directory, "turn-recap.json");
  await writeFile(configPath, JSON.stringify(config), "utf-8");

  return { configPath, directory };
};

/** A response reporting `prompt` uncached context tokens plus its output. */
export const measuredResponse = (
  prompt: number,
  {
    output = 50,
    reasoning = 0,
    stopReason = "stop",
    totalTokens = prompt + output,
  }: { output?: number; reasoning?: number; stopReason?: StopReason; totalTokens?: number } = {},
): AssistantMessage => ({
  ...fauxAssistantMessage("answer", { stopReason }),
  usage: {
    ...sampleUsage(),
    input: prompt,
    output,
    reasoning,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
  },
});

export const sampleUsage = () => ({
  input: 100,
  output: 50,
  cacheRead: 200,
  cacheWrite: 20,
  reasoning: 10,
  totalTokens: 370,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
});

export const snapshot = (): import("../entry.js").Snapshot => ({
  runId: "run-1",
  startedAt: 1000,
  finishedAt: 3000,
  wallMs: 1500,
  outcome: "completed",
  metrics: {
    usage: {
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 20,
      reasoning: 10,
      cost: 0.33,
      reports: 1,
      reasoningReports: 1,
    },
    toolCalls: 3,
    toolErrors: 1,
    responses: 2,
    compactions: 1,
    models: ["provider/model"],
    contextGrowth: 400,
    context: { tokens: 1000, contextWindow: 10000, percent: 10 },
  },
});

/** Deliberately sparse test mappings: consumers must follow the manifest, not builder offsets. */
export const fontManifest = (steps = 8) => ({
  version: 1,
  steps,
  transitions: Object.fromEntries(
    ROLLING_PAIRS.map((pair, index) => [
      pair,
      Array.from({ length: steps + 1 }, (_, frame) => 0xf1000 + index * 0x100 + frame),
    ]),
  ),
});
