import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import type { CliStarter } from "./cli.js";
import type { createCommandRuntime } from "./command-runtime.js";

/** Loads the command runtime on first use, so Pi starts without it. */
export type CommandRuntimeLoader = () => Promise<{
  createCommandRuntime: typeof createCommandRuntime;
}>;

export const loadCommandRuntime: CommandRuntimeLoader = async () =>
  await import("./command-runtime.js");

export const createPlannotatorHost = (
  pi: ExtensionAPI,
  loadRuntime: CommandRuntimeLoader,
  starter?: CliStarter
) => {
  const active = createLazySingleton(async (signal) => {
    const [command, annotate, last, review] = await Promise.all([
      loadRuntime(),
      import("./commands/annotate.js"),
      import("./commands/last.js"),
      import("./commands/review.js"),
    ]);

    signal.throwIfAborted();

    const runtime = command.createCommandRuntime(starter);

    return {
      annotate: annotate.createAnnotateHandler(pi, runtime),
      last: last.createLastHandler(pi, runtime),
      review: review.createReviewHandler(pi, runtime),
      shutdown: runtime.shutdown,
    };
  });

  const run =
    (command: "annotate" | "last" | "review") =>
    async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const runtime = await active.load();
      await runtime?.[command](args, ctx);
    };

  return {
    annotate: run("annotate"),
    last: run("last"),
    review: run("review"),
    shutdown: async (): Promise<void> => {
      await active.stop(async (runtime) => {
        await runtime.shutdown();
      });
    },
  };
};
