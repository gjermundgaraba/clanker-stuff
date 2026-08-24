import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { z } from "zod/v4";

const OAuthSchema = z
  .object({
    authServerMetadataUrl: z.string().optional(),
    callbackPort: z.number().int().optional(),
    clientId: z.string().optional(),
    clientName: z.string().optional(),
    clientSecret: z.string().optional(),
    scopes: z.string().optional(),
  })
  .strict();

const HttpServerConfigSchema = z
  .object({
    headers: z.record(z.string(), z.string()).optional(),
    oauth: OAuthSchema.optional(),
    type: z.enum(["http", "streamable-http"]),
    url: z.string(),
  })
  .strict();

export const ServerConfigSchema = z.union([
  z
    .object({
      args: z.array(z.string()).optional(),
      command: z.string(),
      env: z.record(z.string(), z.string()).optional(),
      type: z.literal("stdio"),
    })
    .strict(),
  HttpServerConfigSchema,
]);

export const McpConfigSchema = z
  .object({
    mcpServers: z.record(z.string(), ServerConfigSchema),
  })
  .strict();

export type McpConfig = z.infer<typeof McpConfigSchema>;
export type McpServerConfig = z.infer<typeof ServerConfigSchema>;
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;
export type HttpOAuthAuthorizationCodeConfig = NonNullable<HttpServerConfig["oauth"]>;
export type McpConfigScope = "global" | "project";

export interface ListedMcpServer {
  name: string;
  scope: McpConfigScope;
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
  return value.replaceAll(pattern, (match, name: string | undefined, fallback?: string) => {
    if (name === undefined || name === "") {
      throw new Error(`invalid MCP config env placeholder: ${match}`);
    }
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

  const parsed = McpConfigSchema.safeParse(JSON.parse(configText));
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      )
      .join(", ");
    throw new Error(`invalid config ${configPath}: ${errors}`);
  }
  return parsed.data;
};

const readScopedMcpConfig = (
  scope: McpConfigScope,
  options: LoadMcpConfigOptions,
): Promise<McpConfig | undefined> => readMcpConfigIfExists(getConfigPath(scope, options));

const getWriteMode = async (configPath: string, scope: McpConfigScope): Promise<number> => {
  try {
    const stats = await stat(configPath);
    return stats.mode % 0o1000;
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

export const addMcpServer = async (
  name: string,
  serverConfig: McpServerConfig,
  scope: McpConfigScope,
  options: LoadMcpConfigOptions,
): Promise<void> => {
  const configPath = getConfigPath(scope, options);
  await withFileMutationQueue(configPath, async () => {
    const config = (await readScopedMcpConfig(scope, options)) ?? {
      mcpServers: {},
    };
    if (Object.hasOwn(config.mcpServers, name)) {
      throw new Error(`MCP server ${name} already exists in the ${scope} config`);
    }
    await writeMcpConfig(configPath, scope, {
      mcpServers: { ...config.mcpServers, [name]: serverConfig },
    });
  });
};

export const removeMcpServer = async (
  name: string,
  scope: McpConfigScope,
  options: LoadMcpConfigOptions,
): Promise<void> => {
  const configPath = getConfigPath(scope, options);
  await withFileMutationQueue(configPath, async () => {
    const config = await readScopedMcpConfig(scope, options);
    if (!config || !Object.hasOwn(config.mcpServers, name)) {
      throw new Error(`MCP server ${name} does not exist in the ${scope} config`);
    }
    const mcpServers = { ...config.mcpServers };
    Reflect.deleteProperty(mcpServers, name);
    await writeMcpConfig(configPath, scope, { mcpServers });
  });
};

export const listMcpServers = async (options: LoadMcpConfigOptions): Promise<ListedMcpServer[]> => {
  const globalConfig = await readScopedMcpConfig("global", options);
  const localConfig =
    options.projectTrusted === true ? await readScopedMcpConfig("project", options) : undefined;
  return Object.keys(mergeMcpConfig(globalConfig, localConfig).mcpServers).map((name) => ({
    name,
    scope: Object.hasOwn(localConfig?.mcpServers ?? {}, name) ? "project" : "global",
  }));
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

const expandMcpConfig = (config: McpConfig): McpConfig => {
  const mcpServers: McpConfig["mcpServers"] = {};
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (server.type === "stdio") {
      const args = server.args?.map(expandEnv);
      const env = expandEnvRecord(server.env);
      const stdioConfig: typeof server = {
        command: expandEnv(server.command),
        type: server.type,
      };
      if (args !== undefined) {
        stdioConfig.args = args;
      }
      if (env !== undefined) {
        stdioConfig.env = env;
      }
      mcpServers[name] = stdioConfig;
      continue;
    }

    const headers = expandEnvRecord(server.headers);
    const oauth =
      server.oauth === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(server.oauth).map(([key, value]) => [
              key,
              Value.Check(Type.String(), value)
                ? expandEnv(Value.Parse(Type.String(), value))
                : value,
            ]),
          );
    const httpConfig: typeof server = {
      type: server.type,
      url: expandEnv(server.url),
    };
    if (headers !== undefined) {
      httpConfig.headers = headers;
    }
    if (oauth !== undefined) {
      httpConfig.oauth = oauth;
    }
    mcpServers[name] = httpConfig;
  }
  return { mcpServers };
};

export const loadMcpConfig = async (options: LoadMcpConfigOptions = {}): Promise<McpConfig> => {
  const globalConfigPath = getConfigPath("global", options);
  const globalConfig = await readScopedMcpConfig("global", options);
  const localConfig =
    options.projectTrusted === true ? await readScopedMcpConfig("project", options) : undefined;

  if (!globalConfig && !localConfig) {
    throw new Error(`missing config file: ${globalConfigPath}`);
  }

  return expandMcpConfig(mergeMcpConfig(globalConfig, localConfig));
};
