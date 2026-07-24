import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CliStarter } from "./cli.js";
import { createCommandRuntime } from "./command-runtime.js";
import { registerAnnotateCommand } from "./commands/annotate.js";
import { registerLastCommand } from "./commands/last.js";
import { registerReviewCommand } from "./commands/review.js";
import { startPlannotatorCli } from "./plannotator.js";

export const createMinimalPlannotatorExtension = (
  startCli: CliStarter = startPlannotatorCli
) =>
  function minimalPlannotator(pi: ExtensionAPI): void {
    const runtime = createCommandRuntime(startCli);

    registerReviewCommand(pi, runtime);
    registerAnnotateCommand(pi, runtime);
    registerLastCommand(pi, runtime);

    pi.on("session_shutdown", runtime.shutdown);
  };

export default createMinimalPlannotatorExtension();
