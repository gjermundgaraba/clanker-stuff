import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

interface PlannotatorRuntime {
  annotate: CommandHandler;
  last: CommandHandler;
  review: CommandHandler;
  shutdown: () => Promise<void>;
}

export const createPlannotatorHost = (pi: ExtensionAPI) => {
  const active = createLazySingleton<PlannotatorRuntime>(async (signal) => {
    const [command, launcher, annotate, last, review] = await Promise.all([
      import("./command-runtime.js"),
      import("./review-launcher.js"),
      import("./commands/annotate.js"),
      import("./commands/last.js"),
      import("./commands/review.js"),
    ]);
    signal.throwIfAborted();
    const runtime = command.createCommandRuntime(
      launcher.createTargetedReviewStarter(command.startPlannotatorCli),
    );
    return {
      annotate: annotate.createAnnotateHandler(pi, runtime),
      last: last.createLastHandler(pi, runtime),
      review: review.createReviewHandler(pi, runtime),
      shutdown: runtime.shutdown,
    };
  });
  const run =
    (command: keyof Pick<PlannotatorRuntime, "annotate" | "last" | "review">) =>
    async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const runtime = await active.load();
      await runtime?.[command](args, ctx);
    };

  return {
    annotate: run("annotate"),
    last: run("last"),
    review: run("review"),
    shutdown: async (): Promise<void> => {
      await active.stop((runtime) => runtime.shutdown());
    },
  };
};
