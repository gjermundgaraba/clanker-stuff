import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { TSchema } from "typebox";

const TOOL_NAME_PREFIX = "mcp_";

export type PiToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export const activateTools = (
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  toolNames: readonly string[],
): void => {
  const active = pi.getActiveTools();
  const activeSet = new Set(active);
  const toAdd = toolNames.filter((name) => !activeSet.has(name));
  if (toAdd.length > 0) {
    pi.setActiveTools([...active, ...toAdd]);
  }
};

const sanitizeNameComponent = (value: string): string => {
  let normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/gu, "_")
    .replaceAll(/_+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  if (!normalized) {
    normalized = "unnamed";
  }
  return /^[0-9]/u.test(normalized) ? `_${normalized}` : normalized;
};

export const toGeneratedToolName = (serverName: string, toolName: string): string =>
  `${TOOL_NAME_PREFIX}${sanitizeNameComponent(serverName)}__${sanitizeNameComponent(toolName)}`;

const safeJson = <T>(value: T): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
};

export const toToolParametersSchema = (inputSchema: Tool["inputSchema"]): TSchema => inputSchema;

export interface PiContentConversion {
  content: PiToolContent[];
  fullText: string;
  truncated: boolean;
}

export const mcpResultToPiContent = (
  result: CallToolResult,
  overflowPath?: string,
): PiContentConversion => {
  const items = result.content;
  const text: string[] = [];
  const images: PiToolContent[] = [];

  for (const item of items) {
    if (item.type === "text") {
      text.push(item.text);
    } else if (item.type === "image") {
      images.push({ data: item.data, mimeType: item.mimeType, type: "image" });
    } else {
      text.push(safeJson(item));
    }
  }
  if (result.structuredContent !== undefined) {
    text.push(safeJson(result.structuredContent));
  }

  const fullText = text.join("\n");
  const truncated = truncateHead(fullText);
  const notice = truncated.truncated
    ? `\n\n[MCP output truncated: kept ${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}${overflowPath === undefined ? "" : `; persisted output: ${overflowPath}`}]`
    : "";
  const content: PiToolContent[] = [
    { text: `${truncated.content}${notice}`, type: "text" },
    ...images,
  ];
  return { content, fullText, truncated: truncated.truncated };
};
