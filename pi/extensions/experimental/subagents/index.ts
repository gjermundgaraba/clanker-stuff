import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.js";
import { createDelegation } from "./delegation.js";
import { SubagentManager } from "./manager.js";

const subagents = async (pi: ExtensionAPI) => {
  const paths = getExtensionStoragePaths("subagents");
  const loaded = await loadConfig(paths.configFile);

  const delegation = createDelegation(pi, loaded.config.delegation);

  const manager = new SubagentManager(pi, {
    config: loaded.config,
    configError: loaded.error,
    dataDir: paths.dataDir,
  });

  pi.registerFlag("ultra", {
    description: "Enable proactive delegation and boost native thinking once at startup",
    type: "boolean",
  });
  pi.registerCommand("proactive", {
    description: "Toggle proactive delegation for this branch without changing thinking",
    handler: async (args, ctx) => delegation.toggle(args, ctx),
  });
  pi.registerCommand("ultra", {
    description: "Enable proactive delegation and select highest native thinking once",
    handler: async (args, ctx) => delegation.ultra(args, ctx),
  });

  pi.on("session_start", delegation.start);
  pi.on("session_tree", (_event, ctx) => delegation.refresh(ctx));
  pi.on("before_agent_start", (_event, ctx) => delegation.refresh(ctx));
  pi.on("session_shutdown", (_event, ctx) => delegation.stop(ctx));
  pi.on("session_start", manager.start.bind(manager));
  pi.on("before_agent_start", manager.beforeAgentStart.bind(manager));
  pi.on("input", manager.input.bind(manager));
  pi.on("turn_start", manager.settle.bind(manager));
  pi.on("agent_settled", manager.settle.bind(manager));
  pi.on("session_shutdown", manager.shutdown.bind(manager));
  pi.registerCommand("agents", {
    description: "Show the subagent tree",
    handler: (_args, ctx) => {
      ctx.ui.notify(manager.describe(), "info");

      return Promise.resolve();
    },
  });
};

export default subagents;
