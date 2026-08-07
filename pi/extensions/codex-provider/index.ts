import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createCodexLifecycle } from "./lifecycle.js";
import { registerCheckpointRenderer } from "./renderer.js";

export default function codexProviderExtension(pi: ExtensionAPI): void {
  const codex = createCodexLifecycle(pi);

  pi.registerProvider(codex.provider);
  registerCheckpointRenderer(pi);

  pi.registerCommand("codex-provider", {
    description: "Show Codex provider and compaction status",
    handler: (args, ctx) => codex.runCommand(args, ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    codex.start(ctx);
  });
  pi.on("model_select", (event) => {
    codex.modelSelect(event);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    codex.beforeAgentStart(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    codex.settled(ctx);
  });
  pi.on("message_end", (event, ctx) => {
    codex.messageEnd(event, ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    codex.shutdown(ctx);
  });
  pi.on("session_before_compact", (event, ctx) =>
    codex.beforeCompact(event, ctx)
  );
  pi.on("session_compact", (event, ctx) => {
    codex.compact(event, ctx);
  });
  pi.on("context", (event, ctx) => codex.context(event, ctx));
  pi.on("before_provider_request", (event, ctx) =>
    codex.beforeProviderRequest(event, ctx)
  );
  pi.on("before_provider_headers", (event, ctx) => {
    codex.beforeProviderHeaders(event, ctx);
  });
}
