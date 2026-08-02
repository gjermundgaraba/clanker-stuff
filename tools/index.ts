import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createToolsRuntime } from "./runtime.js";

export default function toolsExtension(pi: ExtensionAPI): void {
  const runtime = createToolsRuntime(pi);

  pi.registerCommand("code-mode", {
    description: "Toggle GPT-5.6 Codex Code Mode",
    handler: (_args, ctx) => {
      const enabled = runtime.toggleCodeMode();
      runtime.apply(ctx);
      ctx.ui.notify(`Code Mode ${enabled ? "enabled" : "disabled"}`, "info");
      return Promise.resolve();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    runtime.apply(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    runtime.apply(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    const systemPrompt = runtime.augmentSystemPrompt(event.systemPrompt, ctx);
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });

  pi.on("before_provider_request", (event, ctx) =>
    runtime.rewriteProviderRequest(event.payload, ctx)
  );

  pi.on("before_provider_headers", (event, ctx) => {
    runtime.applyProviderHeaders(event.headers, ctx);
  });

  pi.on("session_shutdown", async () => {
    await runtime.dispose();
  });
}
