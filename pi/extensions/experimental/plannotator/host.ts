import type { CliStarter } from "./cli.js";
import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const createPlannotatorHost = (pi: ExtensionAPI, starter?: CliStarter) => {
  const active = createLazySingleton(async (signal) => {
    const [command, annotate, last, review] = await Promise.all([
      import("./command-runtime.js"),
      import("./commands/annotate.js"),
      import("./commands/last.js"),
      import("./commands/review.js"),
    ]);

    signal.throwIfAborted();

    const runtime = command.createCommandRuntime(starter ?? command.startPlannotatorCli);

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
    shutdown: (): Promise<void> => active.stop((runtime) => runtime.shutdown()),
  };
};
