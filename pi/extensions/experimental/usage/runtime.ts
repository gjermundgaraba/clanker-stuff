import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type {
  createUsageController,
  UsageControllerDependencies,
} from "./controller.js";

export type LoadUsageController = () => Promise<typeof createUsageController>;

export const createUsageRuntime = (
  loadController: LoadUsageController,
  dependencies?: UsageControllerDependencies
) => {
  let pendingStart: ExtensionContext | undefined;
  let startupLoad: ReturnType<typeof setImmediate> | undefined;

  const usage = createLazySingleton(
    async (signal) => {
      const createController = await loadController();
      signal.throwIfAborted();

      return createController(dependencies);
    },
    (controller) => {
      if (pendingStart !== undefined) {
        const ctx = pendingStart;
        pendingStart = undefined;
        controller.start(ctx);
      }
    }
  );

  const loadStartup = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await usage.load();
    } catch (error) {
      if (!usage.isStopped()) {
        ctx.ui.notify(
          `Usage failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
    }
  };

  return {
    runCommand: async (
      args: string,
      ctx: ExtensionCommandContext
    ): Promise<void> => {
      const controller = await usage.load();
      await controller?.runCommand(args, ctx);
    },
    sessionStart: (ctx: ExtensionContext): void => {
      const controller = usage.get();

      if (controller !== undefined) {
        controller.start(ctx);

        return;
      }

      pendingStart = ctx;

      if (ctx.mode !== "tui") {
        return;
      }

      if (startupLoad !== undefined) {
        clearImmediate(startupLoad);
      }

      startupLoad = setImmediate(() => {
        startupLoad = undefined;
        void loadStartup(ctx);
      });
    },
    shutdown: async (): Promise<void> => {
      pendingStart = undefined;

      if (startupLoad !== undefined) {
        clearImmediate(startupLoad);
        startupLoad = undefined;
      }

      await usage.stop((controller) => {
        controller.dispose();
      });
    },
    refresh: (ctx: ExtensionContext): void => {
      if (pendingStart !== undefined) {
        pendingStart = ctx;
      }

      usage.get()?.refresh(ctx);
    },
  };
};
