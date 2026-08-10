import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createToolsRuntime } from "./runtime.js";

export default function toolsExtension(pi: ExtensionAPI): void {
  const runtime = createToolsRuntime(pi);

  pi.registerCommand("code-mode", {
    description: "Toggle GPT-5.6 Codex Code Mode",
    handler: (_args, ctx) => {
      runtime.toggleCodeMode(ctx);
      return Promise.resolve();
    },
  });
  pi.registerCommand("tools", {
    description: "Enable/disable tools",
    handler: (_args, ctx) => runtime.openPicker(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    runtime.start(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    runtime.apply(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    runtime.restore(ctx);
  });
  pi.on("before_agent_start", (event, ctx) =>
    runtime.augmentSystemPrompt(event.systemPrompt, ctx)
  );

  pi.on("before_provider_request", (event, ctx) =>
    runtime.rewriteProviderRequest(event.payload, ctx)
  );

  pi.on("before_provider_headers", (event, ctx) => {
    runtime.applyProviderHeaders(event.headers, ctx);
  });
  pi.on("session_shutdown", () => runtime.dispose());
}
