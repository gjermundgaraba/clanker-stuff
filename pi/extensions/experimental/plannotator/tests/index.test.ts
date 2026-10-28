import { setImmediate } from "node:timers/promises";

import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import type { createCommandRuntime } from "../command-runtime.js";
import type { CommandRuntimeLoader } from "../host.js";
import { createPlannotatorExtension } from "../index.js";

describe("plannotator registration", () => {
  it("does not finish loading after shutdown", async () => {
    const createRuntime = vi.fn<typeof createCommandRuntime>();

    const loaded =
      Promise.withResolvers<Awaited<ReturnType<CommandRuntimeLoader>>>();

    const host = createExtensionHost(
      createPlannotatorExtension(async () => await loaded.promise)
    );

    const ctx = host.createContext();

    const command = host.runCommand("plannotator-review", "", ctx);
    const shutdown = host.emitSessionShutdown(ctx);
    await setImmediate();
    loaded.resolve({ createCommandRuntime: createRuntime });
    await shutdown;
    await command;

    expect(createRuntime).not.toHaveBeenCalled();
  });
});
