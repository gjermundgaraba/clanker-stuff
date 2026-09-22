import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { sanitizeRecapText } from "./conversation.js";
import { createTurnRecapRuntime } from "./runtime.js";

export default function turnRecapExtension(pi: ExtensionAPI): void {
  const runtime = createTurnRecapRuntime(pi);

  pi.registerCommand("turn-recap", {
    description: "Toggle detailed turn statistics in the pinned recap card",
    handler: async () => runtime.toggle(),
  });

  pi.events.on("clanker:async-prompt", (event) => runtime.setAsyncPrompt(event));
  pi.on("session_start", (_event, ctx) => runtime.start(ctx));
  pi.on("agent_start", (_event, ctx) => runtime.begin(ctx));
  pi.on("tool_execution_start", (_event, ctx) => runtime.refresh(ctx));
  pi.on("turn_end", (event, ctx) => runtime.boundary(event, ctx));
  pi.on("agent_end", (_event, ctx) => runtime.refresh(ctx));
  pi.on("session_compact", (_event, ctx) => runtime.refresh(ctx));
  pi.on("agent_before_settle", (event, ctx) => runtime.boundary(event, ctx));
  pi.on("agent_settled", (_event, ctx) => {
    void runtime.settled(ctx).catch((error: unknown) => {
      ctx.ui.notify(
        sanitizeRecapText(
          `Turn recap failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        "error",
      );
    });
  });
  pi.on("ui_prompt_start", () => runtime.pause());
  pi.on("ui_prompt_end", () => runtime.resume());
  pi.on("session_tree", (_event, ctx) => runtime.restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => runtime.dispose(ctx));
}
