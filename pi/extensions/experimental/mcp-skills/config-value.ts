// Adapted from Pi's core/resolve-config-value.ts (MIT, Copyright (c) 2025 Mario Zechner), which Pi
// does not export. MCP servers in mcp.json resolve env and header values this way.
import { execSync } from "node:child_process";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const ENV_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/u;

/** A command's trimmed output, run again on every connect like Pi does, so expiring tokens refresh. */
const runCommand = (command: string): string | undefined => {
  try {
    return (
      execSync(command, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
};

/** `$NAME` and `${NAME}` from the environment; `$$` and `$!` escape `$` and `!`. */
const resolveTemplate = (value: string): string | undefined => {
  let resolved = "";
  let index = 0;

  while (index < value.length) {
    const dollar = value.indexOf("$", index);

    if (dollar < 0) return resolved + value.slice(index);

    resolved += value.slice(index, dollar);

    const next = value[dollar + 1];

    if (next === "$" || next === "!") {
      resolved += next;
      index = dollar + 2;
      continue;
    }

    let name: string | undefined;
    let end = dollar + 1;

    if (next === "{") {
      const close = value.indexOf("}", dollar + 2);
      const candidate = close < 0 ? undefined : value.slice(dollar + 2, close);

      if (candidate === undefined || !ENV_NAME.test(candidate)) {
        resolved += close < 0 ? "$" : value.slice(dollar, close + 1);
        index = close < 0 ? dollar + 1 : close + 1;
        continue;
      }

      name = candidate;
      end = close + 1;
    } else {
      name = ENV_NAME_PREFIX.exec(value.slice(dollar + 1))?.[0];
      end = dollar + 1 + (name?.length ?? 0);
    }

    if (name === undefined) {
      resolved += "$";
      index = dollar + 1;
      continue;
    }

    const env = process.env[name];

    if (!env) return undefined;
    resolved += env;
    index = end;
  }

  return resolved;
};

/**
 * Resolve an mcp.json value: `!command` runs the command and uses its output; otherwise environment
 * variable references are replaced. Throws when a referenced variable is unset or the command fails.
 */
export const resolveConfigValue = (value: string, description: string): string => {
  const resolved = value.startsWith("!") ? runCommand(value.slice(1)) : resolveTemplate(value);

  if (resolved === undefined) throw new Error(`Failed to resolve ${description}`);

  return resolved;
};

/** Every value of a map resolved; `description` names the map, and each error names the key too. */
export const resolveConfigValues = (
  values: Readonly<Record<string, string>>,
  description: string,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      resolveConfigValue(value, `${description} "${key}"`),
    ]),
  );
