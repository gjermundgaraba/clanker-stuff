import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.js";
import { SubagentManager } from "./manager.js";

const subagents = async (pi: ExtensionAPI) => {
  const paths = getExtensionStoragePaths("subagents");
  const loaded = await loadConfig(paths.configFile);
  const options = {
    config: loaded.config,
    dataDir: paths.dataDir,
  };
  if (loaded.error !== undefined) {
    Object.assign(options, { configError: loaded.error });
  }
  const manager = new SubagentManager(pi, options);

  pi.on("session_start", manager.start.bind(manager));
  pi.on("resources_discover", (_event, ctx) => manager.discoverResources(ctx));
  pi.on("before_agent_start", manager.beforeAgentStart.bind(manager));
  pi.on("agent_start", manager.agentStart.bind(manager));
  pi.on("agent_settled", manager.agentSettled.bind(manager));
  pi.on("input", manager.input.bind(manager));
  pi.on("model_select", manager.modelSelect.bind(manager));
  pi.on("tool_call", manager.toolCall.bind(manager));
  pi.on("tool_result", manager.toolResult.bind(manager));
  pi.on("session_shutdown", manager.shutdown.bind(manager));
  pi.registerCommand("agents", {
    description: "Show the durable subagent tree",
    handler: (_args, ctx) => {
      ctx.ui.notify(manager.describe(), "info");
      return Promise.resolve();
    },
  });
};

export default subagents;
