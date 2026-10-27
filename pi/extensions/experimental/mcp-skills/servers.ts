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
import { decodeSkillEntry } from "./entry.js";
import type { DeclinedSkill, DecodedEntry, SkillEntry } from "./entry.js";
import { expandHome } from "./mount.js";

const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

/** Room for a 16 MiB file sent as base64 inside a JSON-RPC message. */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

const MAX_LIST_PAGES = 100;

/** How long a server that failed to connect or needs sign-in is left alone before it is tried again. */
const RETRY_MS = 60 * 1000;

const ListPage = Type.Object({
  nextCursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  skills: Type.Array(Type.Unknown()),
});

const GetResult = Type.Object({ skill: Type.Unknown() });

/** Server capabilities that declare the skills extension. */
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

/** What connections need from the session: where they run, and Pi's provider tokens. */
export interface ServerContext {
  agentDir: string;
  cwd: string;
  /** The current token of a Pi provider (`/login`), for servers with `auth.provider`. */
  providerToken: (provider: string) => Promise<string | undefined>;
}

/**
 * Credentials for an HTTP server, as Pi sends them: the configured `Authorization` header, else the
 * token of the provider `auth.provider` names, read for every request so Pi's refreshes apply,
 * else the OAuth token Pi stored at `/mcp` sign-in.
 */
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

/** Stdio and streamable HTTP transports, built like Pi builds them, with a larger message limit. */
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
  /** The session the connection was asked for; a changed working directory makes a new connection. */
  context: ServerContext;
  status: ServerStatus;
  client: McpClient | undefined;
  /** The connect in progress, shared by everyone waiting for this server. */
  opening: Promise<McpClient | undefined> | undefined;
  /** When the last connect started, in milliseconds since the epoch. */
  attemptedAt: number;
}

/** How to sign in to a server again, for a status that needs it. */
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

/**
 * One MCP connection per configured server, separate from Pi's own, that declares the skills
 * extension. Servers that declare it are listed; the others are closed again. A connection that
 * drops is reopened by the next request, and one that failed by `retryFailed`; both list the
 * server's skills again.
 */
export class SkillServers {
  private connections = new Map<string, Connection>();
  /** The servers and working directory connected last, to skip changes that change nothing. */
  private applied = "";
  /** The change being applied; each waits for the one before it. */
  private applying = Promise.resolve();

  /**
   * Connect these servers in the background, closing the current connections first, unless they
   * are the servers already connected. Changes apply in the order they were asked for.
   */
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

  /** Connect again, in the background, servers that failed or needed sign-in a while ago. */
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

  /** Wait until no server is still connecting, or until the timeout. */
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

  /** Host identity of a connected server, which approvals are bound to. */
  origin(server: string): string | undefined {
    const connection = this.connections.get(server);

    return connection && serverOrigin(connection.config);
  }

  /** Replace one skill's listed entry with a fresher one, or drop it when it is no longer loadable. */
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

  /** Read a resource from the server that serves it. Throws when the server is not reachable. */
  async readResource(
    server: string,
    uri: string,
    signal?: AbortSignal
  ): Promise<ReadResourceResult> {
    const client = await this.client(server);

    return await client.readResource(uri, signal ? { signal } : {});
  }

  /** The server's current entry for one skill, by the URI of its `SKILL.md`. */
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

  /** Close every connection, after any change still being applied. */
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

    // Pi's client types predate extension negotiation (SEP-2133) but send unknown capabilities as given.
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
