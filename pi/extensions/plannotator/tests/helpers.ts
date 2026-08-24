import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { Mock } from "vite-plus/test";
import { expect, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import type { CliCompletion, CliStarter, CliStartOptions } from "../cli.js";
import { startPlannotatorCli } from "../command-runtime.js";
import extension from "../index.js";

export interface PendingProcess {
  args: string[];
  cancel: Mock<() => void>;
  options: CliStartOptions;
  reject: (error: Error) => void;
  resolve: (result: CliCompletion) => void;
  signal: AbortSignal;
}

const TestValueSchema = Type.Unknown();
const TestStringSchema = Type.String();
type TestValue = Static<typeof TestValueSchema>;

export const expectString = (value: TestValue): string => Value.Parse(TestStringSchema, value);

export const createStarter = () => {
  const pending: PendingProcess[] = [];
  const starter = vi.fn<CliStarter>((args, options) => {
    const { promise: completion, reject, resolve } = Promise.withResolvers<CliCompletion>();
    const controller = new AbortController();
    const process = {
      args: [...args],
      cancel: vi.fn<() => void>(() => {
        controller.abort();
      }),
      options: { ...options },
      reject,
      resolve,
      signal: controller.signal,
    };
    pending.push(process);
    return {
      cancel: process.cancel,
      completion,
      signal: controller.signal,
    };
  });
  return { pending, starter };
};

// Requires the calling test file to have run
// `vi.mock(import("../command-runtime.js"), { spy: true })`.
export const setup = (entries: SessionEntry[] = [], leafId: string | null = null) => {
  const { pending, starter } = createStarter();
  vi.mocked(startPlannotatorCli).mockImplementation(starter);
  const host = createExtensionHost(extension, { entries, leafId });
  const ctx = host.createContext({ cwd: "/work/project" });
  return { ctx, host, pending, starter };
};

export const exited = (
  stdout: string,
  options: { code?: number; stderr?: string } = {},
): CliCompletion => ({
  code: options.code ?? 0,
  kind: "exited",
  stderr: options.stderr ?? "",
  stdout,
});

export const signaled = (signal: NodeJS.Signals): CliCompletion => ({
  kind: "signaled",
  signal,
});

export const waitForMessages = async (host: ReturnType<typeof setup>["host"], count: number) => {
  await vi.waitFor(() => {
    expect(host.getSentUserMessages()).toHaveLength(count);
  });
};

export const assistantEntry = (
  id: string,
  parentId: string | null,
  text: string,
): SessionEntry => ({
  id,
  message: {
    api: "test",
    content: [{ text, type: "text" }],
    model: "test",
    provider: "test",
    role: "assistant",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  },
  parentId,
  timestamp: new Date().toISOString(),
  type: "message",
});

export const userEntry = (id: string, parentId: string, text: string): SessionEntry => ({
  id,
  message: {
    content: [{ text, type: "text" }],
    role: "user",
    timestamp: Date.now(),
  },
  parentId,
  timestamp: new Date().toISOString(),
  type: "message",
});
