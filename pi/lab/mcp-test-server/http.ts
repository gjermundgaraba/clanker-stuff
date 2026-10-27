import { once } from "node:events";
import { createServer } from "node:http";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpServerFactory } from "@modelcontextprotocol/server";

export interface HttpServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Serve MCP over streamable HTTP at `/mcp` on a loopback address, for both the 2026-07-28
 * revision and 2025-era clients. Requests from other hosts or origins are refused. Port 0 picks
 * a free port.
 */
export const serveHttp = async (
  factory: McpServerFactory,
  options: { host: string; port: number }
): Promise<HttpServer> => {
  const handler = createMcpHandler(factory);
  const handle = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp") {
      res.writeHead(404).end();

      return;
    }

    if (!validateHost(req, res) || !validateOrigin(req, res)) {
      return;
    }

    // @ts-expect-error -- @modelcontextprotocol/node 2.1.2 declares `method?: string` and `url?: string`, which exactOptionalPropertyTypes rejects for IncomingMessage's `string | undefined`; toNodeHandler defaults both when undefined.
    void handle(req, res);
  });

  server.listen(options.port, options.host);
  await once(server, "listening");
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Not listening on TCP");
  }

  return {
    url: `http://${options.host}:${address.port}/mcp`,
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
  };
};
