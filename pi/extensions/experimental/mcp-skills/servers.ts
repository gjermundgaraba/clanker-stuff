import path from "node:path";

import {
  McpAuthRequiredError,
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import type {
  AuthProvider,
  ClientCapabilities,
  McpTransport,
  ReadResourceResult,
} from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { createStoredTokenAuth, hasAuthorizationHeader } from "./auth.js";
import { resolveConfigValues } from "./config-value.js";
import { serverOrigin } from "./config.js";
import type { SkillServerConfig } from "./config.js";
import { decodeSkillEntry, MAX_SKILL_BYTES } from "./entry.js";
import type { DeclinedSkill, DecodedEntry, SkillEntry } from "./entry.js";
import { expandHome } from "./mount.js";

const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

const BASE64_JSON_RPC_HEADROOM = 2;

const MAX_MESSAGE_BYTES = MAX_SKILL_BYTES * BASE64_JSON_RPC_HEADROOM;

const MAX_LIST_PAGES = 100;

const RETRY_MS = 60 * 1000;

const ListPage = Type.Object({
  nextCursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  skills: Type.Array(Type.Unknown()),
});

const GetResult = Type.Object({ skill: Type.Unknown() });

const DeclaresSkills = Type.Object({
  extensions: Type.Object({ [SKILLS_EXTENSION]: Type.Object({}) }),
});

type ServerState =
  | "connecting"
  | "ready"
  | "no-skills"
  | "needs-sign-in"
  | "failed";

export interface ServerStatus {
  name: string;
  state: ServerState;
  error?: string;
  skills: SkillEntry[];
  declined: DeclinedSkill[];
}

export interface ServerContext {
  agentDir: string;
  cwd: string;
  providerToken: (provider: string) => Promise<string | undefined>;
}

const httpAuth = (
  name: string,
  transport: Extract<SkillServerConfig["transport"], { kind: "http" }>,
  headers: Readonly<Record<string, string>>,
  context: ServerContext
): AuthProvider | undefined => {
  const { authProvider, url } = transport;

  if (hasAuthorizationHeader(headers)) {
    return undefined;
  }

  if (authProvider !== undefined) {
    return { token: async () => await context.providerToken(authProvider) };
  }

  return createStoredTokenAuth(context.agentDir, name, url);
};

const createTransport = (
  server: SkillServerConfig,
  context: ServerContext
): McpTransport => {
  const { transport } = server;

  if (transport.kind === "http") {
    const headers = resolveConfigValues(
      transport.headers,
      `MCP server "${server.name}" header`
    );

    const authProvider = httpAuth(server.name, transport, headers, context);

    return new StreamableHttpTransport({
      headers,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      url: transport.url,
      ...(authProvider ? { authProvider } : {}),
    });
  }

  return new StdioTransport({
    args: transport.args.map(expandHome),
    command: expandHome(transport.command),
    cwd: path.resolve(context.cwd, expandHome(transport.cwd ?? ".")),
    env: resolveConfigValues(transport.env, `MCP server "${server.name}" env`),
    maxMessageBytes: MAX_MESSAGE_BYTES,
    stderr: "pipe",
  });
};

export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Connection {
  config: SkillServerConfig;
  context: ServerContext;
  status: ServerStatus;
  client: McpClient | undefined;
  opening: Promise<McpClient | undefined> | undefined;
  attemptedAt: number;
}

const signInHint = (config: SkillServerConfig): string =>
  config.transport.kind === "http" &&
  config.transport.authProvider !== undefined
    ? `log in with /login ${config.transport.authProvider}`
    : "sign in with /mcp, or use one of its tools so Pi refreshes its token";

const listSkills = async (client: McpClient): Promise<DecodedEntry[]> => {
  const entries: DecodedEntry[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result: unknown = await client.request(
      "skills/list",
      cursor === undefined ? {} : { cursor }
    );

    if (!Value.Check(ListPage, result)) {
      throw new Error("invalid skills/list result");
    }

    entries.push(...result.skills.map(decodeSkillEntry));

    const next = result.nextCursor ?? undefined;

    if (next === undefined || next === "") {
      return entries;
    }

    if (cursors.has(next)) {
      throw new Error("skills/list repeated a cursor");
    }

    cursors.add(next);
    cursor = next;
  }

  throw new Error(
    `skills/list returned more than ${String(MAX_LIST_PAGES)} pages`
  );
};

export class SkillServers {
  private connections = new Map<string, Connection>();
  private applied = "";
  private applying = Promise.resolve();

  async apply(
    servers: readonly SkillServerConfig[],
    context: ServerContext
  ): Promise<void> {
    const key = JSON.stringify([servers, context.cwd]);
    const previous = this.applying;

    this.applying = (async () => {
      await previous;

      if (key === this.applied) {
        return;
      }

      await this.close();
      this.applied = key;
      this.start(servers, context);
    })();
    await this.applying;
  }

  private start(
    servers: readonly SkillServerConfig[],
    context: ServerContext
  ): void {
    for (const config of servers) {
      const connection: Connection = {
        attemptedAt: 0,
        client: undefined,
        config,
        context,
        opening: undefined,
        status: {
          declined: [],
          name: config.name,
          skills: [],
          state: "connecting",
        },
      };

      this.connections.set(config.name, connection);
      void this.open(connection);
    }
  }

  retryFailed(): void {
    for (const connection of this.connections.values()) {
      const { state } = connection.status;

      if (
        (state === "failed" || state === "needs-sign-in") &&
        Date.now() - connection.attemptedAt > RETRY_MS
      ) {
        void this.open(connection);
      }
    }
  }

  async settled(timeoutMs: number): Promise<void> {
    const opening = [...this.connections.values()].flatMap((connection) =>
      connection.opening ? [connection.opening] : []
    );

    if (opening.length === 0) {
      return;
    }

    const elapsed = Promise.withResolvers<undefined>();

    const timer = setTimeout(() => {
      elapsed.resolve(undefined);
    }, timeoutMs);

    await Promise.race([Promise.allSettled(opening), elapsed.promise]);
    clearTimeout(timer);
  }

  statuses(): ServerStatus[] {
    return [...this.connections.values()].map(
      (connection) => connection.status
    );
  }

  origin(server: string): string | undefined {
    const connection = this.connections.get(server);

    return connection && serverOrigin(connection.config);
  }

  replaceSkill(server: string, uri: string, decoded: DecodedEntry): void {
    const connection = this.connections.get(server);

    if (!connection) {
      return;
    }

    const { status } = connection;

    this.update(connection, {
      ...status,
      declined: [
        ...status.declined.filter((skill) => skill.uri !== uri),
        ...("declined" in decoded ? [decoded.declined] : []),
      ],
      skills: [
        ...status.skills.filter((skill) => skill.uri !== uri),
        ...("skill" in decoded ? [decoded.skill] : []),
      ],
    });
  }

  async readResource(
    server: string,
    uri: string,
    signal?: AbortSignal
  ): Promise<ReadResourceResult> {
    const client = await this.client(server);

    return await client.readResource(uri, signal ? { signal } : {});
  }

  async getSkill(
    server: string,
    uri: string,
    signal?: AbortSignal
  ): Promise<DecodedEntry> {
    const client = await this.client(server);

    const result: unknown = await client.request(
      "skills/get",
      { uri },
      signal ? { signal } : {}
    );

    if (!Value.Check(GetResult, result)) {
      throw new Error(
        `MCP server "${server}" sent an invalid skills/get result`
      );
    }

    const decoded = decodeSkillEntry(result.skill);

    const decodedUri =
      "skill" in decoded ? decoded.skill.uri : decoded.declined.uri;

    if (decodedUri !== uri) {
      throw new Error(
        `MCP server "${server}" answered skills/get for ${uri} with ${decodedUri}`
      );
    }

    return decoded;
  }

  async stop(): Promise<void> {
    const previous = this.applying;

    this.applying = (async () => {
      await previous;
      await this.close();
    })();
    await this.applying;
  }

  private async close(): Promise<void> {
    const connections = [...this.connections.values()];

    this.connections = new Map();
    this.applied = "";
    await Promise.allSettled(
      connections.map(async (connection) => {
        const client =
          connection.client ??
          (await connection.opening?.catch((): undefined => undefined));

        await client?.close();
      })
    );
  }

  private async client(server: string): Promise<McpClient> {
    const connection = this.connections.get(server);

    if (!connection) {
      throw new Error(`MCP server "${server}" is not connected`);
    }

    if (connection.client?.connectionState === "connected") {
      return connection.client;
    }

    const client = await this.open(connection);

    if (!client) {
      throw new Error(
        connection.status.error ?? `MCP server "${server}" serves no skills`
      );
    }

    return client;
  }

  private async open(connection: Connection): Promise<McpClient | undefined> {
    connection.opening ??= this.connect(connection).finally(() => {
      connection.opening = undefined;
    });

    return await connection.opening;
  }

  private update(
    connection: Connection,
    status: Omit<ServerStatus, "name">
  ): void {
    if (this.connections.get(connection.config.name) !== connection) {
      return;
    }

    connection.status = { ...status, name: connection.config.name };
  }

  private async connect(
    connection: Connection
  ): Promise<McpClient | undefined> {
    const { config } = connection;

    connection.attemptedAt = Date.now();

    const capabilities: ClientCapabilities & {
      extensions: { [SKILLS_EXTENSION]: object };
    } = {
      extensions: { [SKILLS_EXTENSION]: {} },
    };

    const client = new McpClient({
      capabilities,
      name: "pi",
      requestTimeoutMs: config.timeoutMs,
      version: "mcp-skills",
    });

    try {
      await client.connect(createTransport(config, connection.context));

      if (!Value.Check(DeclaresSkills, client.serverCapabilities)) {
        await client.close();
        this.update(connection, {
          declined: [],
          skills: [],
          state: "no-skills",
        });

        return undefined;
      }

      const listed = await listSkills(client);

      if (this.connections.get(config.name) !== connection) {
        await client.close();

        return undefined;
      }

      connection.client = client;
      this.update(connection, {
        declined: listed.flatMap((entry) =>
          "declined" in entry ? [entry.declined] : []
        ),
        skills: listed.flatMap((entry) =>
          "skill" in entry ? [entry.skill] : []
        ),
        state: "ready",
      });

      return client;
    } catch (error) {
      await client.close().catch((): undefined => undefined);
      this.update(connection, {
        declined: connection.status.declined,
        error:
          error instanceof McpAuthRequiredError
            ? `MCP server "${config.name}" needs sign-in; ${signInHint(config)}`
            : describeError(error),
        skills: connection.status.skills,
        state:
          error instanceof McpAuthRequiredError ? "needs-sign-in" : "failed",
      });

      return undefined;
    }
  }
}
