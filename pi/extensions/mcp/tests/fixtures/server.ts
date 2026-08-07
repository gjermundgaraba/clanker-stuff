import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createFixtureMcpServer } from "./mcp-server.ts";

void serveStdio(() => createFixtureMcpServer(process.argv[2] ?? "normal"));
