import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createCardRenderer } from "./card.js";
import { errorText } from "./conversation.js";
import { ENTRY_TYPE } from "./entry.js";
import { createTurnRecapRuntime } from "./runtime.js";

export default function turnRecapExtension(pi: ExtensionAPI): void {
  const runtime = createTurnRecapRuntime(pi);

  // Recap entries have no renderer of their own: each card shows its run's recap in place.
  pi.registerEntryRenderer(
    ENTRY_TYPE,
    createCardRenderer((runId) => runtime.recap(runId)),
  );

  pi.on("session_start", (_event, ctx) => runtime.start(ctx));
  pi.on("agent_start", (_event, ctx) => runtime.begin(ctx));
  // Calls a tool makes itself land on its result; they change nothing until it finishes.
  pi.on("tool_execution_start", (event, ctx) => {
    if (event.parentToolCallId === undefined) runtime.refresh(ctx);
  });
  pi.on("turn_end", (event, ctx) => runtime.boundary(event, ctx));
  pi.on("session_compact", (_event, ctx) => runtime.refresh(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    void runtime.settled(ctx).catch((error: unknown) => {
      ctx.ui.notify(`Turn recap failed: ${errorText(error)}`, "error");
    });
  });
  pi.on("session_shutdown", (_event, ctx) => runtime.shutdown(ctx));
}
