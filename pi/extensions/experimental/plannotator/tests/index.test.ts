import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";

const runtime = vi.hoisted(() => ({
  launch: vi.fn<() => void>(),
  parseArguments: vi.fn<() => string[]>(() => []),
  shutdown: vi.fn<() => Promise<void>>(async () => await Promise.resolve()),
}));

const createRuntime = vi.hoisted(() => vi.fn<() => void>());

// oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise the actual lazy import/shutdown race; injecting the loaded runtime would skip this boundary.
vi.mock(import("../command-runtime.js"), () => ({
  createCommandRuntime: () => {
    createRuntime();

    return runtime;
  },
  startPlannotatorCli: vi.fn<() => never>(),
}));

describe("plannotator registration", () => {
  it("does not finish loading after shutdown", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    const command = host.runCommand("plannotator-review", "", ctx);
    await host.emitSessionShutdown(ctx);
    await command;

    expect(createRuntime).not.toHaveBeenCalled();
  });
});
