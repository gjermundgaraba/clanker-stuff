import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createMcpRuntime } from "./runtime.js";

export default function mcp(pi: ExtensionAPI): void {
  const runtime = createMcpRuntime(pi);

  pi.registerCommand("mcp", {
    description: "Load MCP server tools",
    handler: (_args, ctx) => runtime.pickAndLoad(ctx),
  });

  pi.on("tool_result", (event) => {
    const accounting = runtime.takeSamplingUsage(event.toolCallId);

    if (!accounting) return;

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Foreign tool details are opaque; preserve object fields when attaching sampling accounting without interpreting their schema.
    const details = typeof event.details === "object" ? event.details : undefined;

    return {
      ...(accounting.usage !== undefined ? { usage: accounting.usage } : {}),
      details: { ...details, sampling: accounting.sampling },
    };
  });
  pi.on("session_start", (_event, ctx) => runtime.restore(ctx));
  pi.on("session_tree", (_event, ctx) => runtime.restore(ctx));
  pi.on("session_shutdown", () => runtime.shutdown());
}
