import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import type { CliCompletion, CliStarter, CliStartOptions } from "../cli.js";
import extension from "../index.js";

export interface PendingProcess {
  args: string[];
  options: CliStartOptions;
  reject: (error: Error) => void;
  resolve: (result: CliCompletion) => void;
}

export const createStarter = () => {
  const pending: PendingProcess[] = [];

  const starter = vi.fn<CliStarter>(async (args, options) => {
    const { promise: completion, reject, resolve } = Promise.withResolvers<CliCompletion>();
    pending.push({ args: [...args], options: { ...options }, reject, resolve });

    return await completion;
  });

  return { pending, starter };
};

export const setup = (entries: SessionEntry[] = [], leafId: string | null = null) => {
  const { pending, starter } = createStarter();
  const host = createExtensionHost((pi) => extension(pi, starter), { entries, leafId });
  const ctx = host.createContext({ cwd: "/work/project" });

  return { ctx, host, pending, starter };
};

export const exited = (stdout: string, options: { code?: number } = {}): CliCompletion => ({
  code: options.code ?? 0,
  signal: null,
  stdout,
});

export const signaled = (signal: NodeJS.Signals): CliCompletion => ({
  code: null,
  signal,
  stdout: "",
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
