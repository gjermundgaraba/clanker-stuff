import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createCodexToolsController } from "./controller.js";

export const registerCodexTools = (
  pi: ExtensionAPI,
  setFooterActive: (active: boolean) => void = () => null,
): void => {
  const tools = createCodexToolsController(pi, setFooterActive);

  for (const definition of tools.definitions) {
    pi.registerTool(definition);
  }
  tools.registerOwner();

  pi.registerCommand("code-mode", {
    description: "Toggle Code Mode when the Codex model has no required tool mode",
    handler: (_args, ctx) => {
      tools.toggle(ctx);
      return Promise.resolve();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    tools.start(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    tools.apply(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    tools.sync(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => tools.beforeAgentStart(event.systemPrompt, ctx));
  pi.on("session_before_compact", (_event, ctx) => {
    // A refresh during a running turn takes effect at the next before_agent_start.
    tools.apply(ctx, ctx.isIdle());
  });
  pi.on("session_shutdown", (event) => tools.shutdown(event.reason));
};
