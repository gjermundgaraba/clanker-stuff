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

export const serveHttp = async (
  factory: McpServerFactory,
  options: { host: string; port: number }
): Promise<HttpServer> => {
  const handler = createMcpHandler(factory);
  const handle = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer((req, res) => {
    const { method, url } = req;

    if (
      method === undefined ||
      url === undefined ||
      new URL(url, "http://localhost").pathname !== "/mcp"
    ) {
      res.writeHead(404).end();

      return;
    }

    if (!validateHost(req, res) || !validateOrigin(req, res)) {
      return;
    }

    void handle(Object.assign(req, { method, url }), res);
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
