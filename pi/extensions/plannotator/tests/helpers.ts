import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Mock } from "vitest";
import { expect, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import type { CliCompletion, CliStarter, CliStartOptions } from "../cli.js";
import { startPlannotatorCli } from "../command-runtime.js";
import extension from "../index.js";

export interface PendingProcess {
  args: string[];
  cancel: Mock<() => void>;
  options: CliStartOptions;
  reject: (error: unknown) => void;
  resolve: (result: CliCompletion) => void;
}

export const createStarter = () => {
  const pending: PendingProcess[] = [];
  const starter = vi.fn<CliStarter>((args, options) => {
    const {
      promise: completion,
      reject,
      resolve,
    } = Promise.withResolvers<CliCompletion>();
    const process = {
      args: [...args],
      cancel: vi.fn<() => void>(),
      options: { ...options },
      reject,
      resolve,
    };
    pending.push(process);
    return { cancel: process.cancel, completion };
  });
  return { pending, starter };
};

// Requires the calling test file to have run
// `vi.mock(import("../command-runtime.js"), { spy: true })`.
export const setup = (
  entries: SessionEntry[] = [],
  leafId: string | null = null
) => {
  const { pending, starter } = createStarter();
  vi.mocked(startPlannotatorCli).mockImplementation(starter);
  const host = createExtensionHost(extension, { entries, leafId });
  const ctx = host.createContext({ cwd: "/work/project" });
  return { ctx, host, pending, starter };
};

export const exited = (
  stdout: string,
  options: { code?: number; stderr?: string } = {}
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

export const waitForMessages = async (
  host: ReturnType<typeof setup>["host"],
  count: number
) => {
  await vi.waitFor(() => {
    expect(host.getSentUserMessages()).toHaveLength(count);
  });
};

export const assistantEntry = (
  id: string,
  parentId: string | null,
  text: string
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

export const userEntry = (
  id: string,
  parentId: string,
  text: string
): SessionEntry => ({
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
