import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { CallToolResult } from "@modelcontextprotocol/client";

export const activateTools = (
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  toolNames: readonly string[],
): void => {
  pi.setActiveTools([...new Set([...pi.getActiveTools(), ...toolNames])]);
};

export const toGeneratedToolName = (serverName: string, toolName: string): string => {
  const readable = `${serverName}_${toolName}`.replaceAll(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 42);
  const hash = createHash("sha256")
    .update(JSON.stringify([serverName, toolName]))
    .digest("hex")
    .slice(0, 16);
  return `mcp_${readable}_${hash}`;
};

export const mcpResultToPiContent = (result: CallToolResult) => {
  const content: AgentToolResult<unknown>["content"] = [];
  const text: string[] = [];
  let remainingBytes = DEFAULT_MAX_BYTES;
  let remainingLines = DEFAULT_MAX_LINES;
  let truncated = false;
  const appendText = (value: string) => {
    text.push(value);
    if (remainingBytes <= 0 || remainingLines <= 0) {
      truncated ||= value.length > 0;
      return;
    }
    const part = truncateHead(value, { maxBytes: remainingBytes, maxLines: remainingLines });
    content.push({ type: "text", text: part.content });
    remainingBytes -= part.outputBytes;
    remainingLines -= part.outputLines;
    truncated ||= part.truncated;
  };
  for (const item of result.content) {
    switch (item.type) {
      case "text":
        appendText(item.text);
        break;
      case "image":
        content.push({ type: "image", data: item.data, mimeType: item.mimeType });
        break;
      case "resource":
        appendText(
          "text" in item.resource ? item.resource.text : `[Binary resource: ${item.resource.uri}]`,
        );
        break;
      case "resource_link":
        appendText(JSON.stringify(item));
        break;
      default:
        appendText(`[Unsupported MCP content: ${item.type}]`);
    }
  }
  const hasStructuredText =
    result.structuredContent !== undefined &&
    text.some((value) => {
      try {
        return isDeepStrictEqual(JSON.parse(value), result.structuredContent);
      } catch {
        return false;
      }
    });
  if (result.structuredContent !== undefined && !hasStructuredText)
    appendText(JSON.stringify(result.structuredContent, null, 2));
  const fullText = text.join("\n");
  if (truncated)
    content.push({
      type: "text",
      text: `[MCP output truncated: ${formatSize(Buffer.byteLength(fullText))} total text]`,
    });
  return { content, fullText, truncated };
};
