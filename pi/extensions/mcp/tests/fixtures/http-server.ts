import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  isInitializeRequest,
  isJSONRPCRequest,
} from "@modelcontextprotocol/server";

import { createFixtureMcpServer, createFixtureState } from "./server.ts";
import { z } from "zod/v4";

export const FIXTURE_ACCESS_TOKEN = "fixture-access-token";

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

const sendJson = (res: ServerResponse, value: JsonValue, status = 200): void => {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
};

const readJsonObject = async (req: IncomingMessage): Promise<Record<string, JsonValue>> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("Expected an HTTP request body byte chunk");
    }
    chunks.push(chunk);
  }
  return z.record(z.string(), z.json()).parse(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
};

export const startMcpHttpFixture = async ({
  scenario = "normal",
  oauth = false,
  expireSessionOnce = scenario === "expired" || scenario === "expired-ping",
  expireSessionOn = scenario === "expired-ping" ? "ping" : "tools/call",
  pauseInitialization = false,
}: {
  scenario?: string;
  oauth?: boolean;
  expireSessionOnce?: boolean;
  expireSessionOn?: "ping" | "tools/call";
  pauseInitialization?: boolean;
} = {}) => {
  const state = createFixtureState();
  const legacy = expireSessionOnce || pauseInitialization;
  const mcpHandler = createMcpHandler(() => createFixtureMcpServer(scenario, state), {
    legacy: legacy ? "stateless" : "reject",
  });
  const initializationGate = Promise.withResolvers<null>();
  const initializationStarted = Promise.withResolvers<null>();
  let initializationCount = 0;
  let discoveryCount = 0;
  let sessionExpired = false;
  let toolCallCount = 0;
  let toolGate: Promise<void> | undefined;
  let releaseToolCalls: (() => void) | undefined;
  const pauseToolCalls = () => {
    releaseToolCalls?.();
    const gate = Promise.withResolvers<void>();
    toolGate = gate.promise;
    releaseToolCalls = () => gate.resolve();
    return releaseToolCalls;
  };
  if (scenario === "stalled") pauseToolCalls();
  let malformed = scenario === "malformed";
  let drop = scenario === "drop";
  const requests: { method: string }[] = [];
  const handleMcpRequest = toNodeHandler({
    async fetch(request, options) {
      const body = request.method === "POST" ? await request.clone().json() : undefined;
      if (isJSONRPCRequest(body)) requests.push({ method: body.method });
      if (isJSONRPCRequest(body) && body.method === "tools/call") {
        if (malformed) {
          malformed = false;
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: "invalid" } });
        }
        toolCallCount += 1;
        await toolGate;
      }
      // Session-expiry and initialization-gate tests exercise legacy servers.
      if (legacy && isJSONRPCRequest(body) && body.method === "server/discover") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
      if (pauseInitialization && isInitializeRequest(body)) {
        initializationStarted.resolve(null);
        await initializationGate.promise;
      }
      if (
        expireSessionOnce &&
        !sessionExpired &&
        request.headers.has("mcp-session-id") &&
        isJSONRPCRequest(body) &&
        body.method === expireSessionOn
      ) {
        sessionExpired = true;
        return new Response(null, { status: 404 });
      }

      const response = await mcpHandler.fetch(request, options);
      if (isJSONRPCRequest(body) && body.method === "server/discover") {
        discoveryCount += 1;
      }
      if (isInitializeRequest(body)) {
        initializationCount += 1;
        response.headers.set("mcp-session-id", randomUUID());
      }
      return response;
    },
  });
  let issuer = "";
  let token = FIXTURE_ACCESS_TOKEN;
  let refreshCount = 0;
  let refreshToken = "fixture-refresh-token";
  let rejectRefresh = false;
  let invalidRefreshedToken = false;
  let insufficientScope = false;

  const handleNodeRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const origin = `http://${req.headers.host ?? "localhost"}`;
      const url = new URL(req.url ?? "/", origin);

      if (url.pathname === "/mcp") {
        if (drop && req.method === "POST" && req.headers["mcp-protocol-version"]) {
          drop = false;
          req.destroy();
          return;
        }
        if (oauth && req.headers.authorization !== `Bearer ${token}`) {
          res
            .writeHead(401, {
              "Content-Type": "application/json",
              "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
            })
            .end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (insufficientScope) {
          res
            .writeHead(403, {
              "WWW-Authenticate": `Bearer error="insufficient_scope", scope="tools extra", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
            })
            .end();
          return;
        }
        await handleMcpRequest(req, res);
        return;
      }

      if (url.pathname === "/records") {
        sendJson(res, { records: state.records, operations: state.operations, requests });
        return;
      }
      if (url.pathname === "/control" && req.method === "POST") {
        switch (url.searchParams.get("action")) {
          case "pause":
            pauseToolCalls();
            break;
          case "release":
            releaseToolCalls?.();
            break;
          case "expire-access":
            token = `access-${randomUUID()}`;
            break;
          case "reject-refresh":
            rejectRefresh = true;
            break;
          case "reject-refreshed":
            invalidRefreshedToken = true;
            break;
          case "more-scope":
            insufficientScope = true;
            break;
          case "malformed-next":
            malformed = true;
            break;
          case "drop-next":
            drop = true;
            break;
          default:
            sendJson(res, { error: "unknown_control" }, 400);
            return;
        }
        sendJson(res, { ok: true });
        return;
      }
      if (url.pathname === "/interaction") {
        res
          .writeHead(200, { "Content-Type": "text/html" })
          .end(
            "<!doctype html><title>MCP local interaction</title><h1>Interaction complete</h1><p>Return to Pi and select Completed. This is separate from OAuth.</p>",
          );
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
        insufficientScope = false;
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
          ...(await readJsonObject(req)),
          client_id: "fixture-client-id",
          client_secret: "fixture-client-secret",
        });
        return;
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const chunks: Uint8Array[] = [];
        for await (const chunk of req) {
          if (chunk instanceof Uint8Array) chunks.push(chunk);
        }
        const params = new URLSearchParams(Buffer.concat(chunks).toString());
        if (params.get("grant_type") === "refresh_token") {
          if (rejectRefresh || params.get("refresh_token") !== refreshToken) {
            sendJson(res, { error: "invalid_grant" }, 400);
            return;
          }
          refreshCount += 1;
          refreshToken = `rotated-${refreshCount}`;
        }
        sendJson(res, {
          access_token:
            invalidRefreshedToken && params.get("grant_type") === "refresh_token"
              ? "rejected-token"
              : token,
          refresh_token: refreshToken,
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
  const { port } = z.object({ port: z.number() }).parse(server.address());
  issuer = `http://127.0.0.1:${port}`;

  state.url = `${issuer}/interaction`;
  return {
    state,
    requests,
    close: async () => {
      initializationGate.resolve(null);
      releaseToolCalls?.();
      await mcpHandler.close();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
    expireAccessToken: () => {
      token = `access-${randomUUID()}`;
    },
    rejectRefresh: () => {
      rejectRefresh = true;
    },
    returnInvalidRefreshedToken: () => {
      invalidRefreshedToken = true;
    },
    pauseToolCalls,
    getToolCallCount: () => toolCallCount,
    requireMoreScope: () => {
      insufficientScope = true;
    },
    getRefreshCount: () => refreshCount,
    getInitializationCount: () => initializationCount,
    getDiscoveryCount: () => discoveryCount,
    releaseInitialization: () => initializationGate.resolve(null),
    url: `${issuer}/mcp`,
    waitForInitialization: () => initializationStarted.promise,
  };
};
