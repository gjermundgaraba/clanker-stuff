import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CliStarter } from "./cli.js";
import { createPlannotatorHost, loadCommandRuntime } from "./host.js";
import type { CommandRuntimeLoader } from "./host.js";

export const createPlannotatorExtension = (loadRuntime: CommandRuntimeLoader) =>
  function plannotatorExtension(pi: ExtensionAPI, starter?: CliStarter): void {
    const host = createPlannotatorHost(pi, loadRuntime, starter);

    pi.registerCommand("plannotator-review", {
      description: "Review current changes or a pull request URL",
      handler: host.review,
    });

    pi.registerCommand("plannotator-annotate", {
      description:
        "Open a file, folder, or URL in the Plannotator annotation UI",
      handler: host.annotate,
    });

    pi.registerCommand("plannotator-last", {
      description: "Annotate the last assistant message",
      handler: host.last,
    });

    pi.on("session_shutdown", async () => {
      await host.shutdown();
    });
  };

export default createPlannotatorExtension(loadCommandRuntime);
