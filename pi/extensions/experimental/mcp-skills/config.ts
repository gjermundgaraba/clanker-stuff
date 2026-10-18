// Server loading and validation adapted from Pi's extensions/mcp/config.ts and core/mcp-servers.ts
// (MIT, Copyright (c) 2025 Mario Zechner), which Pi does not export, so that skills connect exactly
// the servers Pi's own MCP support connects.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

const EXPOSURES = ["codemode", "deferred", "direct", "hidden"];

/** Older exposure names Pi still accepts. */
const EXPOSURE_ALIASES = new Map([["codemode-deferred", "codemode"]]);

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Keys a project entry may set to override a global server of the same name. */
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

const Entry = Type.Record(Type.String(), Type.Unknown());

const StringMap = Type.Record(Type.String(), Type.String());

const Strings = Type.Array(Type.String());

const FileSchema = Type.Object({ mcpServers: Type.Optional(Entry) });

type Entry = Static<typeof Entry>;

/** The connection settings of one server, as far as skills need them. */
export type SkillServerTransport =
  | { kind: "http"; url: string; headers: Record<string, string>; authProvider?: string }
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string };

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

/** A server entry Pi accepts: as written, for project overrides to merge into, and as settings. */
interface Accepted {
  raw: Entry;
  settings: Settings;
}

/** Pi's namespace of a server's tools. Names that share one are the same server to Pi. */
export const mcpNamespace = (name: string): string => `mcp__${name.replace(/-/gu, "_")}`;

const isEntry = (value: unknown): value is Entry =>
  !Array.isArray(value) && Value.Check(Entry, value);

/** An exposure by its current name, if the value is a string. */
const exposureName = (value: unknown): string | undefined =>
  typeof value === "string" ? (EXPOSURE_ALIASES.get(value) ?? value) : undefined;

const isExposure = (value: unknown): boolean => EXPOSURES.includes(exposureName(value) ?? "");

const isLoopbackRedirect = (value: string): boolean => {
  if (!URL.canParse(value)) return false;

  const url = new URL(value);

  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.includes(url.hostname) &&
    url.search === "" &&
    url.hash === ""
  );
};

/** Why Pi rejects an `oauth` block. Skills never use it, but a server Pi rejects must not connect. */
const oauthProblem = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;

  if (!isEntry(value)) return "oauth must be an object";

  const { authServerMetadataUrl, callbackPort, callbackUrl, clientId, clientName } = value;
  const { clientRegistration, clientSecret, scope } = value;

  if (clientId !== undefined && typeof clientId !== "string")
    return "oauth.clientId must be a string";

  if (clientSecret !== undefined && typeof clientSecret !== "string") {
    return "oauth.clientSecret must be a string";
  }

  if (
    callbackPort !== undefined &&
    (typeof callbackPort !== "number" ||
      !Number.isInteger(callbackPort) ||
      callbackPort < 1 ||
      callbackPort > 65_535)
  ) {
    return "oauth.callbackPort must be a port number";
  }

  if (callbackUrl !== undefined) {
    if (typeof callbackUrl !== "string" || !isLoopbackRedirect(callbackUrl)) {
      return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
    }

    const port = new URL(callbackUrl).port;

    if (port && callbackPort !== undefined && Number(port) !== callbackPort) {
      return "oauth.callbackUrl and oauth.callbackPort name different ports";
    }
  }

  if (scope !== undefined && typeof scope !== "string") return "oauth.scope must be a string";

  if (clientName !== undefined && (typeof clientName !== "string" || !clientName.trim())) {
    return "oauth.clientName must be a non-empty string";
  }

  if (clientRegistration !== undefined && clientRegistration !== "dcr") {
    if (clientRegistration !== "cimd") return 'oauth.clientRegistration must be "dcr" or "cimd"';

    if (clientId !== undefined || clientName !== undefined) {
      return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
    }

    const callback = typeof callbackUrl === "string" ? new URL(callbackUrl) : undefined;

    if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) {
      return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
    }
  }

  if (authServerMetadataUrl !== undefined) {
    const url =
      typeof authServerMetadataUrl === "string" && URL.canParse(authServerMetadataUrl)
        ? new URL(authServerMetadataUrl)
        : undefined;

    if (
      !url ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))
      )
    ) {
      return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
    }
  }

  return undefined;
};

/** Pi's checks of one server entry: its settings, or why Pi rejects it. */
const validateServer = (name: string, raw: unknown): Settings | string => {
  if (!SERVER_NAME.test(name)) return `invalid server name "${name}"`;

  if (!isEntry(raw)) return `server "${name}" must be an object`;

  const { description, enabled, exposure, timeout, toolExposure, type } = raw;

  if (exposure !== undefined && !isExposure(exposure)) {
    return `server "${name}": exposure must be one of ${EXPOSURES.join(", ")}`;
  }

  if (
    toolExposure !== undefined &&
    !(isEntry(toolExposure) && Object.values(toolExposure).every(isExposure))
  ) {
    return `server "${name}": toolExposure must map tool names to exposures`;
  }

  if (enabled !== undefined && typeof enabled !== "boolean") {
    return `server "${name}": enabled must be a boolean`;
  }

  if (description !== undefined && typeof description !== "string") {
    return `server "${name}": description must be a string`;
  }

  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
    return `server "${name}": timeout must be a positive number of seconds`;
  }

  if (type === "sse") return `server "${name}": legacy SSE transport is not supported`;

  const common = {
    enabled: enabled !== false,
    exposure: exposureName(exposure),
    timeoutMs: (typeof timeout === "number" ? timeout : 60) * 1000,
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

    const oauth = oauthProblem(raw.oauth);

    if (oauth !== undefined) return `server "${name}": ${oauth}`;

    if (auth !== undefined) {
      if (!isEntry(auth) || typeof auth.provider !== "string" || !auth.provider) {
        return `server "${name}": auth.provider must be a provider name`;
      }

      const { hostname, protocol } = new URL(url);

      if (protocol !== "https:" && !LOOPBACK_HOSTS.includes(hostname)) {
        return `server "${name}": auth requires an https URL, or http on a loopback host`;
      }
    }

    const provider = isEntry(auth) && typeof auth.provider === "string" ? auth.provider : undefined;

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

    if (cwd !== undefined && typeof cwd !== "string")
      return `server "${name}": cwd must be a string`;

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
 * Entries Pi rejects are left out; Pi reports them.
 */
const readConfigFile = (path: string, project: boolean, servers: Map<string, Accepted>): void => {
  if (!existsSync(path)) return;

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }

  if (!isEntry(parsed) || !Value.Check(FileSchema, parsed)) return;

  for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
    if (
      project &&
      isEntry(value) &&
      value.command === undefined &&
      value.url === undefined &&
      value.type === undefined
    ) {
      const base = servers.get(name);

      if (base && Object.keys(value).every((key) => OVERRIDE_KEYS.includes(key))) {
        const raw = { ...base.raw, ...value };
        const settings = validateServer(name, raw);

        if (typeof settings !== "string") servers.set(name, { raw, settings });
      }

      continue;
    }

    if (!isEntry(value)) continue;

    const settings = validateServer(name, value);

    if (typeof settings === "string") continue;

    const clashes = [...servers.keys()].some(
      (other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
    );

    // A repository cannot pick where a provider's credential goes.
    const projectAuth =
      project &&
      settings.transport.kind === "http" &&
      settings.transport.authProvider !== undefined;

    if (!clashes && !projectAuth) servers.set(name, { raw: value, settings });
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
 * The enabled, non-hidden servers Pi connects: the global mcp.json, then the trusted project's
 * `.pi/mcp.json`, then servers extensions registered under names no file uses.
 */
export const loadServers = (options: {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  registered: readonly RegisteredMcpServer[];
}): SkillServerConfig[] => {
  const servers = new Map<string, Accepted>();

  readConfigFile(join(options.agentDir, "mcp.json"), false, servers);

  if (options.projectTrusted) {
    readConfigFile(join(options.cwd, CONFIG_DIR_NAME, "mcp.json"), true, servers);
  }

  const configured = [...servers.keys()].map(mcpNamespace);

  const registered = options.registered.flatMap(({ config, name }) => {
    const settings = validateServer(name, config);

    return typeof settings === "string" || configured.includes(mcpNamespace(name))
      ? []
      : [{ name, settings }];
  });

  return [
    ...[...servers].map(([name, { settings }]) => ({ name, settings })),
    ...registered,
  ].flatMap(({ name, settings }) =>
    settings.enabled && settings.exposure !== "hidden"
      ? [{ name, timeoutMs: settings.timeoutMs, transport: settings.transport }]
      : [],
  );
};
