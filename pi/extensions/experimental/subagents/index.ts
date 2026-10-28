import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { SHAPE_SPINNER_COMMAND } from "@clanker-stuff/pi-shape-glyphs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.js";
import { createDelegation } from "./delegation.js";
import { SubagentManager } from "./manager.js";
import { SUBAGENT_MESSAGE_TYPE } from "./protocol.js";
import { mailRenderer } from "./renderers.js";
import { BRAILLE_MARKS, orbMarks } from "./ui/format.js";
import { Presenter, VIEWER_SHORTCUT } from "./ui/presenter.js";

const subagents = async (pi: ExtensionAPI) => {
  const paths = getExtensionStoragePaths("subagents");
  const loaded = await loadConfig(paths.configFile);

  const delegation = createDelegation(pi, loaded.config.delegation);

  const manager = new SubagentManager(pi, {
    config: loaded.config,
    configError: loaded.error,
    dataDir: paths.dataDir,
  });

  const presenter = new Presenter(manager.source);

  pi.registerFlag("ultra", {
    description:
      "Enable proactive delegation and boost native thinking once at startup",
    type: "boolean",
  });
  pi.registerCommand("proactive", {
    description:
      "Toggle proactive delegation for this branch without changing thinking",
    handler: async (args, ctx) => {
      delegation.toggle(args, ctx);
    },
  });
  pi.registerCommand("ultra", {
    description:
      "Enable proactive delegation and select highest native thinking once",
    handler: async (args, ctx) => {
      delegation.ultra(args, ctx);
    },
  });

  pi.on("session_start", delegation.start);
  pi.on("session_tree", (_event, ctx) => {
    delegation.refresh(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    delegation.refresh(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    delegation.stop(ctx);
  });
  pi.on("session_start", manager.start.bind(manager));
  pi.on("before_agent_start", manager.beforeAgentStart.bind(manager));
  pi.on("input", manager.input.bind(manager));
  pi.on("context", (_event, ctx) => {
    manager.request(ctx);
  });
  pi.on("agent_before_settle", manager.beforeSettle.bind(manager));
  pi.on("turn_start", manager.settle.bind(manager));
  pi.on("agent_settled", manager.settled.bind(manager));
  pi.on("ui_prompt_start", () => {
    manager.prompt(true);
  });
  pi.on("ui_prompt_end", () => {
    manager.prompt(false);
  });
  pi.on("session_tree", () => {
    manager.navigate();
  });
  pi.on("session_shutdown", manager.shutdown.bind(manager));
  pi.on("session_start", (_event, ctx) => {
    const spinnerFont = pi
      .getCommands()
      .some(
        ({ name, source }) =>
          source === "extension" && name === SHAPE_SPINNER_COMMAND
      );

    presenter.start(
      ctx,
      spinnerFont ? orbMarks(() => manager.source.nodes()) : BRAILLE_MARKS
    );
  });
  pi.on("session_shutdown", () => {
    presenter.stop();
  });
  pi.registerMessageRenderer(SUBAGENT_MESSAGE_TYPE, mailRenderer);
  pi.registerCommand("agents", {
    description: "Open the subagent viewer",
    handler: async (_args, ctx) => {
      await presenter.open(ctx);
    },
  });
  pi.registerShortcut(VIEWER_SHORTCUT, {
    description: "Open the subagent viewer",
    handler: async (ctx) => {
      await presenter.open(ctx);
    },
  });
};

export default subagents;
