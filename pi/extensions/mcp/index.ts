import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createMcpRuntime } from "./runtime.js";

export default function mcp(pi: ExtensionAPI): void {
  const runtime = createMcpRuntime(pi);

  pi.registerCommand("mcp", {
    description: "Load MCP server tools",
    handler: (_args, ctx) => runtime.pickAndLoad(ctx),
  });

  pi.on("session_start", (_event, ctx) => runtime.restore(ctx));
  pi.on("session_tree", (_event, ctx) => runtime.restore(ctx));
  pi.on("session_shutdown", () => runtime.shutdown());
}
