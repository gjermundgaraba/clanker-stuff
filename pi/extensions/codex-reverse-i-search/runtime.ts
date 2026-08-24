import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import type { ExtensionContext, InputEvent, UserBashEvent } from "@earendil-works/pi-coding-agent";

import type { createReverseSearch } from "./controller.js";

type ReverseSearch = ReturnType<typeof createReverseSearch>;

export const createReverseSearchRuntime = () => {
  let context: ExtensionContext | undefined;
  const search = createLazySingleton<ReverseSearch>(
    async (signal) => {
      const { createReverseSearch } = await import("./controller.js");
      signal.throwIfAborted();
      return createReverseSearch();
    },
    (controller) => {
      if (context !== undefined) {
        controller.start(context);
      }
    },
  );

  return {
    async importHistory(ctx: ExtensionContext) {
      const controller = await search.load();
      await controller?.importHistory(ctx);
    },
    async open(ctx: ExtensionContext) {
      const controller = await search.load();
      controller?.open(ctx);
    },
    async recordBash(event: UserBashEvent, ctx: ExtensionContext) {
      const controller = await search.load();
      controller?.recordBash(event, ctx);
    },
    async recordInput(event: InputEvent, ctx: ExtensionContext) {
      const controller = await search.load();
      controller?.recordInput(event, ctx);
    },
    sessionStart(ctx: ExtensionContext) {
      context = ctx;
      search.get()?.start(ctx);
    },
    async shutdown(ctx: ExtensionContext) {
      context = undefined;
      await search.stop((controller) => controller.dispose(ctx));
    },
  };
};
