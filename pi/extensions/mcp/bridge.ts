import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { Type } from "typebox";
import type { TSchema } from "typebox";

const TOOL_NAME_PREFIX = "mcp_";
const OPEN_OBJECT_SCHEMA = Type.Object({}, { additionalProperties: true });

export type PiToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export const activateTools = (
  pi: ExtensionAPI,
  toolNames: readonly string[]
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

export const toGeneratedToolName = (
  serverName: string,
  toolName: string
): string =>
  `${TOOL_NAME_PREFIX}${sanitizeNameComponent(serverName)}__${sanitizeNameComponent(toolName)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
};

export const toToolParametersSchema = (inputSchema: unknown): TSchema =>
  isRecord(inputSchema) && inputSchema.type === "object"
    ? inputSchema
    : OPEN_OBJECT_SCHEMA;

export const normalizeToolArguments = (
  args: unknown
): Record<string, unknown> => (isRecord(args) ? args : {});

export const mcpResultToPiContent = (
  result: CallToolResult,
  overflowPath?: string
): { content: PiToolContent[]; fullText: string; truncated: boolean } => {
  const items = result.content;
  const text: string[] = [];
  const images: PiToolContent[] = [];

  for (const item of items) {
    if (
      isRecord(item) &&
      item.type === "text" &&
      typeof item.text === "string"
    ) {
      text.push(item.text);
    } else if (
      isRecord(item) &&
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
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
