import { readFile } from "node:fs/promises";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const GLOBAL_CONFIG_FILE = "mcp.json";
const LOCAL_CONFIG_FILE = ".mcp.json";

const HttpServerConfigSchema = Type.Object(
  {
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    oauth: Type.Optional(
      Type.Object(
        {
          authServerMetadataUrl: Type.Optional(Type.String()),
          callbackPort: Type.Optional(Type.Integer()),
          clientId: Type.Optional(Type.String()),
          clientName: Type.Optional(Type.String()),
          clientSecret: Type.Optional(Type.String()),
          scopes: Type.Optional(Type.String()),
        },
        { additionalProperties: false }
      )
    ),
    type: Type.Union([Type.Literal("http"), Type.Literal("streamable-http")]),
    url: Type.String(),
  },
  { additionalProperties: false }
);

const StdioServerConfigSchema = Type.Object(
  {
    args: Type.Optional(Type.Array(Type.String())),
    command: Type.String(),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    type: Type.Literal("stdio"),
  },
  { additionalProperties: false }
);

const ServerConfigSchema = Type.Union([
  HttpServerConfigSchema,
  StdioServerConfigSchema,
]);

export const McpConfigSchema = Type.Object(
  {
    mcpServers: Type.Record(Type.String(), ServerConfigSchema),
  },
  { additionalProperties: false }
);

export type McpConfig = Static<typeof McpConfigSchema>;
export type HttpServerConfig = Static<typeof HttpServerConfigSchema>;
export type HttpOAuthAuthorizationCodeConfig = NonNullable<
  HttpServerConfig["oauth"]
>;

export interface LoadMcpConfigOptions {
  cwd?: string;
  projectTrusted?: boolean;
}

const getErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

const mergeMcpConfig = (
  globalConfig: McpConfig | undefined,
  localConfig: McpConfig | undefined
): McpConfig => ({
  mcpServers: {
    ...globalConfig?.mcpServers,
    ...localConfig?.mcpServers,
  },
});

const expandEnv = (value: string): string => {
  const pattern =
    /\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)(?::-(?<fallback>[^}]*))?\}/gu;
  return value.replaceAll(pattern, (match: string) => {
    pattern.lastIndex = 0;
    const executed = pattern.exec(match);
    const name = executed?.groups?.name;
    if (typeof name !== "string" || name === "") {
      throw new Error(`invalid MCP config env placeholder: ${match}`);
    }
    const envValue = process.env[name];
    if (envValue !== undefined) {
      return envValue;
    }
    const fallback = executed?.groups?.fallback;
    if (typeof fallback === "string") {
      return fallback;
    }
    throw new Error(
      `missing environment variable in MCP config: ${name} (${match})`
    );
  });
};

const readMcpConfigIfExists = async (
  configPath: string,
  label: string
): Promise<McpConfig | undefined> => {
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
    const errors = [...Value.Errors(McpConfigSchema, parsed)]
      .map((e) =>
        e.instancePath ? `${e.instancePath}: ${e.message}` : e.message
      )
      .join(", ");
    throw new Error(`invalid config ${label}: ${errors}`);
  }
  return parsed;
};

const expandEnvRecord = (
  record: Record<string, string> | undefined
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
      mcpServers[name] = {
        command: expandEnv(server.command),
        type: server.type,
        ...(args === undefined ? {} : { args }),
        ...(env === undefined ? {} : { env }),
      };
      continue;
    }

    const headers = expandEnvRecord(server.headers);
    mcpServers[name] = {
      type: server.type,
      url: expandEnv(server.url),
      ...(headers === undefined ? {} : { headers }),
      ...(server.oauth === undefined ? {} : { oauth: server.oauth }),
    };
  }
  return { mcpServers };
};

export const loadMcpConfig = async (
  options: LoadMcpConfigOptions = {}
): Promise<McpConfig> => {
  const globalConfigPath = path.join(
    getAgentDir(),
    "extensions",
    GLOBAL_CONFIG_FILE
  );
  const localConfigPath = path.resolve(
    options.cwd ?? process.cwd(),
    LOCAL_CONFIG_FILE
  );

  const globalConfig = await readMcpConfigIfExists(
    globalConfigPath,
    GLOBAL_CONFIG_FILE
  );
  const localConfig =
    options.projectTrusted === true
      ? await readMcpConfigIfExists(localConfigPath, localConfigPath)
      : undefined;

  if (!globalConfig && !localConfig) {
    throw new Error(`missing config file: ${globalConfigPath}`);
  }

  return expandMcpConfig(mergeMcpConfig(globalConfig, localConfig));
};
