import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadedServerNames } from "./loaded-servers.js";
import type { createMcpLoader } from "./loader.js";

type McpLoader = ReturnType<typeof createMcpLoader>;

export const createMcpRuntime = (pi: ExtensionAPI) => {
  const loader = createLazySingleton<McpLoader>(async (signal) => {
    const { createMcpLoader } = await import("./loader.js");
    signal.throwIfAborted();
    return createMcpLoader(pi);
  });

  const restore = async (ctx: ExtensionContext): Promise<void> => {
    if (
      loader.isStopped() ||
      (loader.get() === undefined &&
        !loader.isLoading() &&
        loadedServerNames(ctx.sessionManager.getBranch()).length === 0)
    ) {
      return;
    }
    const activeLoader = await loader.load();
    await activeLoader?.restore(ctx);
  };

  return {
    pickAndLoad: async (ctx: ExtensionCommandContext): Promise<void> => {
      const activeLoader = await loader.load();
      await activeLoader?.pickAndLoad(ctx);
    },
    restore,
    shutdown: async (): Promise<void> => {
      await loader.stop((activeLoader) => activeLoader.dispose());
    },
  };
};
