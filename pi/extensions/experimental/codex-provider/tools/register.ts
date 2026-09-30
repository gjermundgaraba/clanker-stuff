import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodexModelCatalog } from "../model-catalog.js";
import { createCodexToolsController } from "./controller.js";

interface CodexToolsOptions {
  readonly setFooterActive?: (active: boolean) => void;
  readonly evaluationToolMode?: "direct" | "code_mode_only";
}

export const registerCodexTools = (
  pi: ExtensionAPI,
  catalog: CodexModelCatalog,
  { setFooterActive = () => null, evaluationToolMode }: CodexToolsOptions = {},
): void => {
  const tools = createCodexToolsController(
    pi,
    setFooterActive,
    catalog.supportsModel,
    evaluationToolMode,
  );

  for (const definition of tools.definitions) pi.registerTool(definition);
  pi.registerCommand("code-mode", {
    description: "Toggle Code Mode when the Codex model has no required tool mode",
    handler: (_args, ctx) => {
      tools.toggle(ctx);

      return Promise.resolve();
    },
  });
  pi.on("session_start", (_event, ctx) => tools.apply(ctx));
  pi.on("model_select", (_event, ctx) => tools.apply(ctx));
  pi.on("session_tree", (_event, ctx) => tools.apply(ctx));
  pi.on("input", (_event, ctx) => {
    if (ctx.isIdle()) tools.apply(ctx);
  });
  pi.on("session_before_compact", (_event, ctx) => tools.apply(ctx, ctx.isIdle()));
  pi.on("session_shutdown", (event) => tools.shutdown(event.reason));
};
