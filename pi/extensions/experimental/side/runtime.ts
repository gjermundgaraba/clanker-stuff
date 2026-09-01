import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { createSideController } from "./controller.js";

type SideController = ReturnType<typeof createSideController>;

export const createSideRuntime = (pi: ExtensionAPI) => {
  const side = createLazySingleton<SideController>(async (signal) => {
    const { createSideController } = await import("./controller.js");
    signal.throwIfAborted();
    return createSideController(pi);
  });

  return {
    closeOnTreeChange: async (ctx: ExtensionContext): Promise<void> => {
      if (side.get() === undefined && !side.isLoading()) {
        return;
      }
      const controller = await side.load();
      await controller?.closeOnTreeChange(ctx);
    },
    launch: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const controller = await side.load();
      await controller?.launch(args, ctx);
    },
    shutdown: async (): Promise<void> => {
      await side.stop((controller) => controller.dispose());
    },
    toggle: async (ctx: ExtensionContext): Promise<void> => {
      const controller = await side.load();
      await controller?.toggle(ctx);
    },
  };
};
