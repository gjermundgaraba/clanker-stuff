/* oxlint-disable eslint/class-methods-use-this -- process manager test double delegates to shared spies */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createCodexDirectTools } from "../tools/direct.js";
import type { ProcessManager, ProcessResult } from "../tools/process.js";

const processManager = vi.hoisted(() => ({
  construct: vi.fn<() => void>(),
  continue: vi.fn<() => Promise<ProcessResult>>(async () => ({
    durationMs: 0,
    exitCode: 0,
    output: "continued",
    running: false,
    status: "exited",
  })),
  dispose: vi.fn<() => Promise<void>>(async () => await Promise.resolve()),
  start: vi.fn<() => Promise<ProcessResult>>(async () => ({
    durationMs: 0,
    exitCode: 0,
    output: "started",
    running: false,
    status: "exited",
  })),
}));

vi.mock(import("../tools/process.js"), () => {
  const mocked = {
    ProcessManager: class {
      constructor() {
        processManager.construct();
      }

      continue = () => processManager.continue();

      dispose = () => processManager.dispose();

      start = () => processManager.start();
    },
  };
  return mocked as unknown as {
    ProcessManager: new () => ProcessManager;
  };
});

describe("Codex direct tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries process manager construction after failure", async () => {
    processManager.construct.mockImplementationOnce(() => {
      throw new Error("load failed");
    });
    let direct: ReturnType<typeof createCodexDirectTools> | undefined;
    const host = createExtensionHost((pi) => {
      direct = createCodexDirectTools();
      for (const definition of direct.definitions) {
        pi.registerTool(definition);
      }
    });

    await expect(
      host.runTool("exec_command", { cmd: "echo first" })
    ).rejects.toThrow("load failed");
    await expect(
      host.runTool("exec_command", { cmd: "echo second" })
    ).resolves.toMatchObject({
      content: [{ text: "started", type: "text" }],
    });
    await direct?.dispose();

    expect(processManager.construct).toHaveBeenCalledTimes(2);
    expect(processManager.start).toHaveBeenCalledOnce();
    expect(processManager.dispose).toHaveBeenCalledOnce();
  });
});
