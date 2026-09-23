import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CodexModelCatalog } from "./model-catalog.js";

import { ToolExecutionSettings } from "./tools/execution-context.js";

import { createCodexFooter } from "./footer.js";
import { createLazyCodexProvider } from "./lazy-provider.js";
import { registerCheckpointRenderer } from "./renderer.js";
import { createCodexRuntime } from "./runtime.js";
import { exposeSkillsWithoutRead } from "./skill-catalog.js";
import { registerCodexUltra } from "./ultra/index.js";

/** Register provider lifecycle and transport, optionally composing tool policy. */
export function registerCodexProvider(
  pi: ExtensionAPI,
  registerTools?: (
    setCodeMode: (active: boolean) => void,
    settings: ToolExecutionSettings,
    catalog: CodexModelCatalog,
  ) => void,
): void {
  const footer = createCodexFooter(pi);
  const settings = new ToolExecutionSettings();
  const runtime = createCodexRuntime(pi, footer.setFastMode, settings);

  pi.registerFlag("fast", {
    description: "Start with OpenAI Codex fast mode enabled",
    type: "boolean",
  });

  pi.registerProvider(createLazyCodexProvider(runtime.catalog, runtime.loadProvider));
  registerCheckpointRenderer(pi);
  registerTools?.(footer.setCodeMode, settings, runtime.catalog);
  registerCodexUltra(pi, runtime.catalog, footer.setUltraMode);

  pi.registerCommand("fast", {
    description: "Toggle OpenAI Codex fast mode",
    handler: (_args, ctx) => runtime.fast(ctx),
  });

  pi.registerCommand("codex-provider", {
    description: "Show Codex provider and compaction status",
    handler: (args, ctx) => runtime.command(args, ctx),
  });

  pi.on("session_start", (event, ctx) => runtime.sessionStart(ctx, event.reason === "startup"));
  pi.on("model_select", (event, ctx) => {
    runtime.modelSelect(event, ctx);
  });
  // Tool policy can change after Pi captures this event's systemPromptOptions.
  pi.on("before_agent_start", (event, ctx) => {
    exposeSkillsWithoutRead(event, ctx, pi.getActiveTools());
  });
  pi.on("before_agent_start", (_event, ctx) => runtime.beforeAgentStart(ctx));
  pi.on("agent_end", () => {
    runtime.agentEnd();
  });
  pi.on("agent_start", () => {
    runtime.agentStart();
  });
  pi.on("agent_settled", (_event, ctx) => {
    runtime.agentSettled(ctx);
  });
  pi.on("message_end", (event, ctx) => {
    runtime.messageEnd(event, ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => runtime.shutdown(ctx));
  pi.on("session_shutdown", () => {
    footer.dispose();
  });
  pi.on("session_before_compact", (event, ctx) => runtime.beforeCompact(event, ctx));
  pi.on("session_compact", (event, ctx) => {
    runtime.sessionCompact(event, ctx);
  });
  pi.on("session_compact_failed", () => runtime.sessionCompactFailed());
  pi.on("context", (event, ctx) => runtime.context(event, ctx));
  pi.on("before_provider_request", (event, ctx) => runtime.beforeProviderRequest(event, ctx));
  pi.on("before_provider_headers", (event, ctx) => runtime.beforeProviderHeaders(event, ctx));
}
