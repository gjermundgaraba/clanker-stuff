import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createMcpLoader } from "./loader.js";

export default function mcp(pi: ExtensionAPI): void {
  const loader = createMcpLoader(pi);

  pi.registerCommand("mcp", {
    description: "Load MCP server tools",
    handler: (_args, ctx) => loader.pickAndLoad(ctx),
  });

  pi.on("session_start", (_event, ctx) => loader.restore(ctx));
  pi.on("session_shutdown", () => loader.dispose());
}
