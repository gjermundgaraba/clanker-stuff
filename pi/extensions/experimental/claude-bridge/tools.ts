// Tool names and arguments between pi and Claude Code. The query runs with
// `tools: []`, so every tool Claude can call is a pi tool served over MCP as
// `mcp__custom-tools__<pi name>`.

import type { JsonObject, Tool } from "@earendil-works/pi-ai";

export const MCP_SERVER_NAME = "custom-tools";

export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export interface ServedTools {
  tools: Tool[];
  /** Pi name (and its lowercase form) → served MCP name. */
  toSdk: Map<string, string>;
  /** Served MCP name (and its lowercase form) → pi name. */
  toPi: Map<string, string>;
}

export function resolveServedTools(tools: readonly Tool[] | undefined): ServedTools {
  const served: ServedTools = { tools: [], toSdk: new Map(), toPi: new Map() };

  for (const tool of tools ?? []) {
    const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;

    served.tools.push(tool);
    served.toSdk.set(tool.name, sdkName);
    served.toSdk.set(tool.name.toLowerCase(), sdkName);
    served.toPi.set(sdkName, tool.name);
    served.toPi.set(sdkName.toLowerCase(), tool.name);
  }

  return served;
}

// Only pi tools served over MCP are legitimate. Any other name is the model inventing a
// builtin (`bash`, `Edit`, an MCP server we don't serve). Claude Code answers those
// itself with "No such tool available" and retries under a fresh tool_use id without
// dispatching to our server, so such a call must not reach pi: forwarding one ran a tool
// Claude Code never dispatched and left the retry's handler with no result to release
// it, deadlocking both sides.
export const piToolNameFor = (
  name: string,
  toPi: ReadonlyMap<string, string>,
): string | undefined => toPi.get(name) ?? toPi.get(name.toLowerCase());

// Claude Code parameter names that differ from pi's. Unlisted keys pass through, so new
// pi parameters work automatically; pi's own prepareArguments hooks handle structure.
const SDK_KEY_RENAMES = new Map<string, ReadonlyMap<string, string>>([
  ["read", new Map([["file_path", "path"]])],
  ["write", new Map([["file_path", "path"]])],
  [
    "edit",
    new Map([
      ["file_path", "path"],
      ["old_string", "oldText"],
      ["new_string", "newText"],
      ["old_text", "oldText"],
      ["new_text", "newText"],
    ]),
  ],
]);

// Claude Code's own default; pi's bash tool has none.
const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

export function mapToolArgs(toolName: string, args: JsonObject): JsonObject {
  const renames = SDK_KEY_RENAMES.get(toolName.toLowerCase());
  const result: JsonObject = {};

  for (const [key, value] of Object.entries(args)) {
    const piKey = renames?.get(key) ?? key;

    // First alias wins.
    if (!(piKey in result)) result[piKey] = value;
  }

  if (toolName.toLowerCase() === "bash" && result.timeout == null) {
    result.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
  }

  return result;
}
