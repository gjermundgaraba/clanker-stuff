import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createCodexToolsController } from "./controller.js";

export const registerCodexTools = (
  pi: ExtensionAPI,
  setFooterActive: (active: boolean) => void = () => null
): void => {
  const tools = createCodexToolsController(pi, setFooterActive);

  for (const definition of tools.definitions) {
    pi.registerTool(definition);
  }
  tools.publishOwner();

  pi.registerCommand("code-mode", {
    description: "Toggle GPT-5.6 Codex Code Mode",
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
  pi.on("before_agent_start", (event, ctx) =>
    tools.beforeAgentStart(event.systemPrompt, ctx)
  );
  pi.on("session_shutdown", (event) => tools.shutdown(event.reason));
};
