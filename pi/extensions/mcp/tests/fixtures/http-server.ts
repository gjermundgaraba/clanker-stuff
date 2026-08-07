import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  isInitializeRequest,
  isJSONRPCRequest,
} from "@modelcontextprotocol/server";

import { createFixtureMcpServer } from "./mcp-server.js";

export const FIXTURE_ACCESS_TOKEN = "fixture-access-token";

const sendJson = (res: ServerResponse, value: unknown, status = 200): void => {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(value));
};

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
};

export const startMcpHttpFixture = async (
  oauth = false,
  expireSessionOnce = false
) => {
  const mcpHandler = createMcpHandler(() => createFixtureMcpServer());
  let initializationCount = 0;
  let sessionExpired = false;
  const handleMcpRequest = toNodeHandler({
    async fetch(request, options) {
      if (!expireSessionOnce) {
        return mcpHandler.fetch(request, options);
      }

      const body =
        request.method === "POST" ? await request.clone().json() : undefined;
      if (
        !sessionExpired &&
        request.headers.has("mcp-session-id") &&
        isJSONRPCRequest(body) &&
        body.method === "tools/call"
      ) {
        sessionExpired = true;
        return new Response(null, { status: 404 });
      }

      const response = await mcpHandler.fetch(request, options);
      if (isInitializeRequest(body)) {
        initializationCount += 1;
        response.headers.set("mcp-session-id", randomUUID());
      }
      return response;
    },
  });
  let issuer = "";

  const handleNodeRequest = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    try {
      const origin = `http://${req.headers.host ?? "localhost"}`;
      const url = new URL(req.url ?? "/", origin);

      if (url.pathname === "/mcp") {
        if (
          oauth &&
          req.headers.authorization !== `Bearer ${FIXTURE_ACCESS_TOKEN}`
        ) {
          res
            .writeHead(401, {
              "Content-Type": "application/json",
              "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
            })
            .end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        await handleMcpRequest(req, res);
        return;
      }

      if (!oauth) {
        res.writeHead(404).end();
        return;
      }

      if (url.pathname === "/.well-known/oauth-protected-resource") {
        sendJson(res, {
          authorization_servers: [issuer],
          resource: issuer,
          scopes_supported: ["tools"],
        });
        return;
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        sendJson(res, {
          authorization_endpoint: `${issuer}/authorize`,
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code"],
          issuer,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          token_endpoint: `${issuer}/token`,
          token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
        });
        return;
      }

      if (url.pathname === "/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        if (redirectUri === null) {
          sendJson(res, { error: "invalid_request" }, 400);
          return;
        }
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("code", "fixture-auth-code");
        const state = url.searchParams.get("state");
        if (state !== null) {
          redirect.searchParams.set("state", state);
        }
        res.writeHead(302, { Location: redirect.toString() }).end();
        return;
      }

      if (url.pathname === "/register" && req.method === "POST") {
        sendJson(res, {
          ...((await readJson(req)) as Record<string, unknown>),
          client_id: "fixture-client-id",
          client_secret: "fixture-client-secret",
        });
        return;
      }

      if (url.pathname === "/token" && req.method === "POST") {
        sendJson(res, {
          access_token: FIXTURE_ACCESS_TOKEN,
          refresh_token: "fixture-refresh-token",
          token_type: "Bearer",
        });
        return;
      }

      sendJson(res, { error: "not_found" }, 404);
    } catch (error) {
      res
        .writeHead(500, { "Content-Type": "text/plain" })
        .end(error instanceof Error ? error.message : String(error));
    }
  };

  const server = createServer((req, res) => void handleNodeRequest(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${port}`;

  return {
    close: async () => {
      await mcpHandler.close();
      server.close();
      await once(server, "close");
    },
    getInitializationCount: () => initializationCount,
    url: `${issuer}/mcp`,
  };
};
