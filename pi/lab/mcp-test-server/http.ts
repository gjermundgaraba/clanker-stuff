import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { McpServerFactory } from "@modelcontextprotocol/server";

/**
 * Serve MCP over streamable HTTP at `/mcp` on a loopback address, for both the 2026-07-28
 * revision and 2025-era clients. Requests from other hosts or origins are refused.
 */
export const serveHttp = async (
  factory: McpServerFactory,
  options: { host: string; port: number },
): Promise<void> => {
  const handler = createMcpHandler(factory);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? options.host}`);

      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();

        return;
      }

      const headers = new Headers();

      for (const [name, value] of Object.entries(req.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
          headers.append(name, item);
      }

      const method = req.method ?? "GET";

      const request = new Request(url, {
        body: method === "GET" || method === "HEAD" ? null : Readable.toWeb(req),
        duplex: "half",
        headers,
        method,
      });

      const response =
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
        originValidationResponse(request, localhostAllowedOrigins()) ??
        (await handler.fetch(request));

      res.writeHead(response.status, Object.fromEntries(response.headers));

      if (response.body) await pipeline(response.body, res);
      else res.end();
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
};
