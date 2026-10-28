import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function mcpTestServer(pi: ExtensionAPI): void {
  pi.registerMcpServer("test", {
    args: [fileURLToPath(new URL("cli.ts", import.meta.url))],
    command: "node",
  });
}
