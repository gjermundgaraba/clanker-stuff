// Server loading and validation adapted from Pi's extensions/mcp/config.ts and core/mcp-servers.ts
// (MIT, Copyright (c) 2025 Mario Zechner), which Pi does not export. Only settings skills use are
// validated: `oauth`, `description`, and `toolExposure` are ignored, since skills use Pi's stored
// tokens and no tools.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

/** Server names Pi accepts, which are also safe as one path segment. */
export const SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

const EXPOSURES = ["codemode", "deferred", "direct", "hidden"];

/** Older exposure names Pi still accepts. */
const EXPOSURE_ALIASES = new Map([["codemode-deferred", "codemode"]]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Keys a project entry may set to override a global server of the same name. Skills ignore
 * `toolExposure`, but an override that also sets it must still apply.
 */
const OVERRIDE_KEYS = new Set(["enabled", "exposure", "toolExposure"]);

const Entry = Type.Record(Type.String(), Type.Unknown());

const StringMap = Type.Record(Type.String(), Type.String());

const Strings = Type.Array(Type.String());

const FileSchema = Type.Object({ mcpServers: Type.Optional(Entry) });

type Entry = Static<typeof Entry>;

/** The connection settings of one server, as far as skills need them. */
export type SkillServerTransport =
  | {
      kind: "http";
      url: string;
      headers: Record<string, string>;
      authProvider?: string;
    }
  | {
      kind: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    };

export interface SkillServerConfig {
  /** Host label: the server name in mcp.json, which the built-in MCP tools also use. */
  name: string;
  transport: SkillServerTransport;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

interface Settings {
  enabled: boolean;
  exposure: string | undefined;
  timeoutMs: number;
  transport: SkillServerTransport;
}

/** An accepted server entry: as written, for project overrides to merge into, and as settings. */
interface Accepted {
  raw: Entry;
  settings: Settings;
}

/** Pi's namespace of a server's tools. Names that share one are the same server to Pi. */
export const mcpNamespace = (name: string): string =>
  `mcp__${name.replaceAll("-", "_")}`;

const isEntry = (value: unknown): value is Entry =>
  !Array.isArray(value) && Value.Check(Entry, value);

/** An exposure by its current name, if the value is a string. */
const exposureName = (value: unknown): string | undefined =>
  typeof value === "string"
    ? (EXPOSURE_ALIASES.get(value) ?? value)
    : undefined;

/** Pi's checks of the settings skills use: connection settings or a rejection reason. */
const validateServer = (name: string, raw: unknown): Settings | string => {
  if (!SERVER_NAME.test(name)) {
    return `invalid server name "${name}"`;
  }

  if (!isEntry(raw)) {
    return `server "${name}" must be an object`;
  }

  const { enabled, exposure, timeout, type } = raw;

  if (
    exposure !== undefined &&
    !EXPOSURES.includes(exposureName(exposure) ?? "")
  ) {
    return `server "${name}": exposure must be one of ${EXPOSURES.join(", ")}`;
  }

  if (enabled !== undefined && typeof enabled !== "boolean") {
    return `server "${name}": enabled must be a boolean`;
  }

  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !(timeout > 0))
  ) {
    return `server "${name}": timeout must be a positive number of seconds`;
  }

  if (type === "sse") {
    return `server "${name}": legacy SSE transport is not supported`;
  }

  const common = {
    enabled: enabled !== false,
    exposure: exposureName(exposure),
    timeoutMs: (timeout ?? 60) * 1000,
  };

  const { args, auth, command, cwd, env, headers, url } = raw;

  if (
    typeof url === "string" &&
    (type === undefined || type === "http" || type === "streamable-http")
  ) {
    if (!URL.canParse(url) || !/^https?:$/u.test(new URL(url).protocol)) {
      return `server "${name}": url must be an http or https URL`;
    }

    if (headers !== undefined && !Value.Check(StringMap, headers)) {
      return `server "${name}": headers must map names to strings`;
    }

    let provider: string | undefined;

    if (auth !== undefined) {
      if (
        !isEntry(auth) ||
        typeof auth["provider"] !== "string" ||
        !auth["provider"]
      ) {
        return `server "${name}": auth.provider must be a provider name`;
      }

      const { hostname, protocol } = new URL(url);

      if (protocol !== "https:" && !LOOPBACK_HOSTS.has(hostname)) {
        return `server "${name}": auth requires an https URL, or http on a loopback host`;
      }

      ({ provider } = auth);
    }

    return {
      ...common,
      transport: {
        headers: headers ?? {},
        kind: "http",
        url,
        ...(provider === undefined ? {} : { authProvider: provider }),
      },
    };
  }

  if (typeof command === "string" && (type === undefined || type === "stdio")) {
    if (args !== undefined && !Value.Check(Strings, args)) {
      return `server "${name}": args must be an array of strings`;
    }

    if (env !== undefined && !Value.Check(StringMap, env)) {
      return `server "${name}": env must map names to strings`;
    }

    if (cwd !== undefined && typeof cwd !== "string") {
      return `server "${name}": cwd must be a string`;
    }

    return {
      ...common,
      transport: {
        args: args ?? [],
        command,
        env: env ?? {},
        kind: "stdio",
        ...(cwd === undefined ? {} : { cwd }),
      },
    };
  }

  return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
};

/**
 * Read one mcp.json into `servers` as Pi does. A project entry with none of `command`, `url`, and
 * `type` overrides only `enabled`, `exposure`, and `toolExposure` of the global server it names.
 * Invalid connection entries are left out.
 */
const readConfigFile = (
  file: string,
  project: boolean,
  servers: Map<string, Accepted>
): void => {
  if (!existsSync(file)) {
    return;
  }

  let parsed: unknown;

  try {
    // Like Pi, accept the UTF-8 BOM that Windows PowerShell 5.1 writes.
    parsed = JSON.parse(readFileSync(file, "utf-8").replace(/^\uFEFF/u, ""));
  } catch {
    return;
  }

  if (!isEntry(parsed) || !Value.Check(FileSchema, parsed)) {
    return;
  }

  for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
    if (
      project &&
      isEntry(value) &&
      value["command"] === undefined &&
      value["url"] === undefined &&
      value["type"] === undefined
    ) {
      const base = servers.get(name);

      if (base && Object.keys(value).every((key) => OVERRIDE_KEYS.has(key))) {
        const raw = { ...base.raw, ...value };
        const settings = validateServer(name, raw);

        if (typeof settings !== "string") {
          servers.set(name, { raw, settings });
        }
      }

      continue;
    }

    if (!isEntry(value)) {
      continue;
    }

    const settings = validateServer(name, value);

    if (typeof settings === "string") {
      continue;
    }

    const clashes = [...servers.keys()].some(
      (other) => other !== name && mcpNamespace(other) === mcpNamespace(name)
    );

    // A repository cannot pick where a provider's credential goes.
    const projectAuth =
      project &&
      settings.transport.kind === "http" &&
      settings.transport.authProvider !== undefined;

    if (!clashes && !projectAuth) {
      servers.set(name, { raw: value, settings });
    }
  }
};

/**
 * Host identity of a server: its label plus what it connects to. Approvals are bound to it, so a
 * label reused for another endpoint or command does not inherit them.
 */
export const serverOrigin = (server: SkillServerConfig): string => {
  const { transport } = server;

  const target =
    transport.kind === "http"
      ? [transport.url]
      : [transport.command, ...transport.args, transport.cwd ?? ""];

  return `${server.name}#${createHash("sha256").update(JSON.stringify(target)).digest("hex").slice(0, 16)}`;
};

/**
 * Enabled, non-hidden servers from the global mcp.json, then the trusted project's
 * `.pi/mcp.json`, then servers extensions registered under names no file uses.
 */
export const loadServers = (options: {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  registered: readonly RegisteredMcpServer[];
}): SkillServerConfig[] => {
  const servers = new Map<string, Accepted>();

  readConfigFile(path.join(options.agentDir, "mcp.json"), false, servers);

  if (options.projectTrusted) {
    readConfigFile(
      path.join(options.cwd, CONFIG_DIR_NAME, "mcp.json"),
      true,
      servers
    );
  }

  const configured = new Set([...servers.keys()].map(mcpNamespace));

  const registered = options.registered.flatMap(({ config, name }) => {
    const settings = validateServer(name, config);

    return typeof settings === "string" || configured.has(mcpNamespace(name))
      ? []
      : [{ name, settings }];
  });

  return [
    ...[...servers].map(([name, { settings }]) => ({ name, settings })),
    ...registered,
  ].flatMap(({ name, settings }) =>
    settings.enabled && settings.exposure !== "hidden"
      ? [{ name, timeoutMs: settings.timeoutMs, transport: settings.transport }]
      : []
  );
};
