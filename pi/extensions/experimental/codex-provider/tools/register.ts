import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ToolExecutionSettings } from "./execution-context.js";

import { createCodexToolsController } from "./controller.js";

export const registerCodexTools = (
  pi: ExtensionAPI,
  setFooterActive: (active: boolean) => void = () => null,
  evaluationToolMode?: "direct" | "code_mode_only",
  executionSettings?: ToolExecutionSettings,
): void => {
  const tools = createCodexToolsController(
    pi,
    setFooterActive,
    evaluationToolMode,
    executionSettings,
  );

  for (const definition of tools.definitions) {
    pi.registerTool(definition);
  }

  pi.registerCommand("code-mode", {
    description: "Toggle Code Mode when the Codex model has no required tool mode",
    handler: (_args, ctx) => {
      tools.toggle(ctx);
      return Promise.resolve();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    executionSettings?.reset(ctx.sessionManager.getSessionId());
    tools.apply(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    tools.apply(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    executionSettings?.clear();
    tools.apply(ctx);
  });
  pi.on("input", (_event, ctx) => {
    // Normalize before Pi captures prompt text and tool metadata, not during a running turn.
    if (ctx.isIdle()) tools.apply(ctx);
  });
  pi.on("turn_end", () => executionSettings?.clear());
  pi.on("agent_end", () => executionSettings?.clear());
  pi.on("session_shutdown", () => executionSettings?.reset());
  pi.on("before_agent_start", (event) => tools.beforeAgentStart(event.systemPrompt));
  pi.on("session_before_compact", (_event, ctx) => {
    // A refresh during a running turn takes effect on the next idle input.
    tools.apply(ctx, ctx.isIdle());
  });
  pi.on("session_shutdown", (event) => tools.shutdown(event.reason));
};
