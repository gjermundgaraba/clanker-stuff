import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Static } from "typebox";

const OAuthSchema = Type.Object(
  {
    authServerMetadataUrl: Type.Optional(Type.String()),
    callbackPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    clientId: Type.Optional(Type.String()),
    clientName: Type.Optional(Type.String()),
    clientSecret: Type.Optional(Type.String()),
    scopes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const HttpServerConfigSchema = Type.Object(
  {
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    oauth: Type.Optional(OAuthSchema),
    type: Type.Literal("http"),
    url: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ServerConfigSchema = Type.Union([
  Type.Object(
    {
      args: Type.Optional(Type.Array(Type.String())),
      command: Type.String({ minLength: 1 }),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      type: Type.Literal("stdio"),
    },
    { additionalProperties: false },
  ),
  HttpServerConfigSchema,
]);

// Validate the document separately: an invalid server must remain removable.
const McpConfigSchema = Type.Object(
  {
    mcpServers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: true },
);

export type McpConfig = Required<Static<typeof McpConfigSchema>>;
export type McpServerConfig = Static<typeof ServerConfigSchema>;
export type HttpServerConfig = Static<typeof HttpServerConfigSchema>;
export type McpConfigScope = "global" | "project";

export interface ListedMcpServer {
  name: string;
  scope: McpConfigScope;
  error?: string;
}

export interface LoadMcpConfigOptions {
  cwd?: string;
  projectTrusted?: boolean;
}

const getErrorCode = (cause: unknown): string | undefined =>
  cause instanceof Object && "code" in cause ? String(cause.code) : undefined;

const getConfigPath = (scope: McpConfigScope, options: LoadMcpConfigOptions): string => {
  const paths = getExtensionStoragePaths("mcp");
  if (scope === "global") {
    return paths.configFile;
  }
  if (options.projectTrusted !== true) {
    throw new Error("project-local MCP config requires a trusted project");
  }
  return paths.project(options.cwd ?? process.cwd()).configFile;
};

const mergeMcpConfig = (
  globalConfig: McpConfig | undefined,
  localConfig: McpConfig | undefined,
): McpConfig => ({
  mcpServers: {
    ...globalConfig?.mcpServers,
    ...localConfig?.mcpServers,
  },
});

const expandEnv = (value: string): string => {
  const pattern = /\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)(?::-(?<fallback>[^}]*))?\}/gu;
  return value.replaceAll(pattern, (match, name: string, fallback?: string) => {
    const envValue = process.env[name];
    if (envValue !== undefined) {
      return envValue;
    }
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`missing environment variable in MCP config: ${name} (${match})`);
  });
};

const readMcpConfigIfExists = async (configPath: string): Promise<McpConfig | undefined> => {
  let configText: string;
  try {
    configText = await readFile(configPath, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(configText);
  if (!Value.Check(McpConfigSchema, parsed)) {
    throw new Error(
      `invalid config ${configPath}: expected an object with an optional mcpServers map`,
    );
  }
  return { ...parsed, mcpServers: parsed.mcpServers ?? {} };
};

const readScopedMcpConfig = (
  scope: McpConfigScope,
  options: LoadMcpConfigOptions,
): Promise<McpConfig | undefined> => readMcpConfigIfExists(getConfigPath(scope, options));

const readMcpScopes = async (options: LoadMcpConfigOptions) => {
  const globalConfig = await readScopedMcpConfig("global", options);
  const localConfig =
    options.projectTrusted === true ? await readScopedMcpConfig("project", options) : undefined;
  return { globalConfig, localConfig };
};

const getWriteMode = async (configPath: string, scope: McpConfigScope): Promise<number> => {
  try {
    const stats = await stat(configPath);
    return stats.mode & 0o777;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return scope === "global" ? 0o600 : 0o644;
    }
    throw error;
  }
};

const writeMcpConfig = async (
  configPath: string,
  scope: McpConfigScope,
  config: McpConfig,
): Promise<void> => {
  await mkdir(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const mode = await getWriteMode(configPath, scope);
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf-8",
      mode,
    });
    await chmod(tempPath, mode);
    await rename(tempPath, configPath);
  } finally {
    await rm(tempPath, { force: true });
  }
};

export const setMcpServer = async (
  name: string,
  serverConfig: McpServerConfig,
  scope: McpConfigScope,
  options: LoadMcpConfigOptions,
  signal?: AbortSignal,
): Promise<void> => {
  const configPath = getConfigPath(scope, options);
  await withFileMutationQueue(configPath, async () => {
    signal?.throwIfAborted();
    const config = (await readScopedMcpConfig(scope, options)) ?? {
      mcpServers: {},
    };
    signal?.throwIfAborted();
    await writeMcpConfig(configPath, scope, {
      ...config,
      mcpServers: { ...config.mcpServers, [name]: serverConfig },
    });
  });
};

export const removeMcpServer = async (
  name: string,
  scope: McpConfigScope,
  options: LoadMcpConfigOptions,
  signal?: AbortSignal,
): Promise<void> => {
  const configPath = getConfigPath(scope, options);
  await withFileMutationQueue(configPath, async () => {
    signal?.throwIfAborted();
    const config = await readScopedMcpConfig(scope, options);
    if (!config || !Object.hasOwn(config.mcpServers, name)) return;
    const mcpServers = { ...config.mcpServers };
    Reflect.deleteProperty(mcpServers, name);
    signal?.throwIfAborted();
    await writeMcpConfig(configPath, scope, { ...config, mcpServers });
  });
};

export const listMcpServers = async (options: LoadMcpConfigOptions): Promise<ListedMcpServer[]> => {
  const { globalConfig, localConfig } = await readMcpScopes(options);
  return Object.entries(mergeMcpConfig(globalConfig, localConfig).mcpServers).map(
    ([name, server]) => {
      const listed: ListedMcpServer = {
        name,
        scope: Object.hasOwn(localConfig?.mcpServers ?? {}, name) ? "project" : "global",
      };
      if (!Value.Check(ServerConfigSchema, server)) listed.error = "Invalid server configuration";
      return listed;
    },
  );
};

const expandEnvRecord = (
  record: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (record === undefined) {
    return undefined;
  }
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    expanded[key] = expandEnv(value);
  }
  return expanded;
};

export const resolveMcpServer = (config: McpConfig, name: string): McpServerConfig => {
  const server = config.mcpServers[name];
  if (server === undefined) {
    throw new Error(`MCP server ${name} is not configured`);
  }
  if (!Value.Check(ServerConfigSchema, server)) throw new Error("Invalid MCP server configuration");
  if (server.type === "stdio") {
    return {
      ...server,
      command: expandEnv(server.command),
      args: server.args?.map(expandEnv),
      env: expandEnvRecord(server.env),
    };
  }

  const oauth = server.oauth === undefined ? undefined : { ...server.oauth };
  if (oauth !== undefined) {
    if (oauth.authServerMetadataUrl !== undefined) {
      oauth.authServerMetadataUrl = expandEnv(oauth.authServerMetadataUrl);
    }
    if (oauth.clientId !== undefined) oauth.clientId = expandEnv(oauth.clientId);
    if (oauth.clientName !== undefined) oauth.clientName = expandEnv(oauth.clientName);
    if (oauth.clientSecret !== undefined) oauth.clientSecret = expandEnv(oauth.clientSecret);
    if (oauth.scopes !== undefined) oauth.scopes = expandEnv(oauth.scopes);
  }
  const httpConfig: typeof server = {
    ...server,
    url: expandEnv(server.url),
    headers: expandEnvRecord(server.headers),
    oauth,
  };
  for (const url of [httpConfig.url, httpConfig.oauth?.authServerMetadataUrl]) {
    if (url !== undefined && !["http:", "https:"].includes(new URL(url).protocol)) {
      throw new Error("MCP URLs must use HTTP or HTTPS");
    }
  }
  return httpConfig;
};

export const loadMcpConfig = async (options: LoadMcpConfigOptions = {}): Promise<McpConfig> => {
  const { globalConfig, localConfig } = await readMcpScopes(options);

  return mergeMcpConfig(globalConfig, localConfig);
};
