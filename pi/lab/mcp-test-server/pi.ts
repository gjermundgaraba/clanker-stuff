// Load with `pi -e pi/lab/mcp-test-server/pi.ts` to connect the test server as "test" for one session.
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function mcpTestServer(pi: ExtensionAPI): void {
  pi.registerMcpServer("test", {
    args: [fileURLToPath(new URL("cli.ts", import.meta.url))],
    command: "node",
  });
}
