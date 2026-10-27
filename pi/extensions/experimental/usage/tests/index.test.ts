import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import type { createUsageController } from "../controller.js";
import extension, { createUsageExtension } from "../index.js";

const fakeController = () => {
  const controller = {
    dispose: vi.fn<() => void>(),
    runCommand:
      vi.fn<(args: string, ctx: ExtensionCommandContext) => Promise<void>>(),
    start: vi.fn<(ctx: ExtensionContext) => void>(),
    refresh: vi.fn<(ctx: ExtensionContext) => void>(),
  };

  const createController = vi.fn<typeof createUsageController>(
    () => controller
  );

  return { controller, createController };
};

describe("usage registration", () => {
  it("offers refresh for an empty or fuzzy argument and nothing for a non-match", async () => {
    const host = createExtensionHost(extension);
    await host.ready;

    const complete = host
      .getRegisteredCommands()
      .get("usage")?.getArgumentCompletions;

    const values = async (prefix: string) => {
      const items = await complete?.(prefix);

      return items?.map((item) => item.value);
    };

    await expect(values("")).resolves.toStrictEqual(["refresh"]);
    await expect(values(" rf")).resolves.toStrictEqual(["refresh"]);
    await expect(values("x")).resolves.toStrictEqual([]);
  });

  it("does not finish loading after shutdown", async () => {
    const { createController } = fakeController();
    const loadStarted = Promise.withResolvers<undefined>();
    const loaded = Promise.withResolvers<typeof createUsageController>();

    const host = createExtensionHost(
      createUsageExtension(undefined, async () => {
        loadStarted.resolve(undefined);

        return await loaded.promise;
      })
    );

    const ctx = host.createContext();

    const command = host.runCommand("usage", "", ctx);
    await loadStarted.promise;
    const shutdown = host.emitSessionShutdown(ctx);
    loaded.resolve(createController);
    await shutdown;
    await command;

    expect(createController).not.toHaveBeenCalled();
  });

  it("reports background startup failures", async () => {
    const { controller, createController } = fakeController();
    createController.mockImplementationOnce(() => {
      throw new Error("load failed");
    });

    const host = createExtensionHost(
      createUsageExtension(undefined, async () => createController)
    );

    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    await vi.waitFor(() => {
      expect(host.getNotifications()).toContainEqual({
        message: "Usage failed to initialize: load failed",
        type: "error",
      });
    });
    await host.runCommand("usage", "", ctx);
    await host.emitSessionShutdown(ctx);

    expect(createController).toHaveBeenCalledTimes(2);
    expect(controller.runCommand).toHaveBeenCalledOnce();
  });
});
