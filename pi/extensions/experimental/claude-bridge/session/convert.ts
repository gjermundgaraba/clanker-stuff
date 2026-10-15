// Pi history → the Anthropic message shape Claude Code's session files hold.

import type { ImageContent, Message as PiMessage, TextContent } from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage } from "cc-session-io";

import { MCP_TOOL_PREFIX } from "../tools.js";

export const PROVIDER_ID = "claude-bridge";

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
  const existing = cache.get(id);

  if (existing !== undefined) return existing;

  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");

  cache.set(id, clean);

  return clean;
}

/** A pi tool name as a rebuilt transcript must call it. Every tool Claude can call is a
 *  pi tool served over MCP, named `mcp__custom-tools__<pi name>` by construction; the map
 *  is consulted first only for the served tool's exact casing. A name it lacks is a tool
 *  pi ran that is not served now (an extension since disabled), and naming it after a
 *  Claude Code builtin would tell the model a tool it cannot call was already used: the
 *  prompt condition behind the phantom-call deadlock that piToolNameFor also guards. */
export function mapPiToolNameToSdk(name: string, toSdk: ReadonlyMap<string, string>): string {
  if (name === "") return "";

  const normalized = name.toLowerCase();

  // Prefixing an already-converted name invents a tool nobody serves.
  if (normalized.startsWith(MCP_TOOL_PREFIX)) {
    throw new Error(
      `mapPiToolNameToSdk: "${name}" is already an SDK tool name; pi history holds pi tool names`,
    );
  }

  return toSdk.get(name) ?? toSdk.get(normalized) ?? `${MCP_TOOL_PREFIX}${name}`;
}

/** Any content block, including ones extensions add outside pi's types. */
export interface LooseBlock {
  type: string;
  text?: string;
}

export function messageContentToText(content: string | readonly LooseBlock[]): string {
  if (typeof content === "string") return content;

  const parts: string[] = [];
  let hasText = false;

  for (const block of content) {
    if (block.type === "text" && block.text !== undefined && block.text !== "") {
      parts.push(block.text);
      hasText = true;
    } else if (block.type !== "text" && block.type !== "image") {
      parts.push(`[${block.type}]`);
    }
  }

  return hasText ? parts.join("\n") : "";
}

const imageBlock = (block: ImageContent): ContentBlock => ({
  type: "image",
  source: { type: "base64", media_type: block.mimeType, data: block.data },
});

// Tool results are flattened to text, which is how Claude Code stores most of them.
// Images have no text form, so a result carrying one keeps the block array shape (what
// Claude Code writes for screenshots).
function toolResultContent(
  content: readonly (TextContent | ImageContent)[],
): string | ContentBlock[] {
  if (
    !content.some((block) => block.type === "image" && block.data !== "" && block.mimeType !== "")
  ) {
    return messageContentToText(content);
  }

  const blocks: ContentBlock[] = [];

  for (const block of content) {
    // Widened first: an extension's off-type block still gets the same marker
    // messageContentToText leaves for it.
    const blockType: string = block.type;

    if (block.type === "text") {
      if (block.text !== "") blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      if (block.data !== "" && block.mimeType !== "") blocks.push(imageBlock(block));
    } else {
      blocks.push({ type: "text", text: `[${blockType}]` });
    }
  }

  return blocks;
}

/** What conversion discarded, for the debug trace: a stripped thinking block and one that
 *  never existed convert to the same thing, so without this the loss is invisible. */
export interface DroppedContent {
  thinking: number;
  abortedTurns: number;
  providers: Set<string>;
  other: Map<string, number>;
}

export interface ConvertedMessages {
  anthropicMessages: SessionMessage[];
  sanitizedIds: Map<string, string>;
  dropped: DroppedContent;
}

type ToolResultsMessage = SessionMessage & { content: ContentBlock[] };

export function convertPiMessages(
  messages: readonly PiMessage[],
  toSdk: ReadonlyMap<string, string>,
): ConvertedMessages {
  const anthropicMessages: SessionMessage[] = [];
  const sanitizedIds = new Map<string, string>();

  const dropped: DroppedContent = {
    thinking: 0,
    abortedTurns: 0,
    providers: new Set(),
    other: new Map(),
  };

  // The user message collecting this assistant turn's tool results, and the index of
  // the assistant message it belongs to. See the toolResult branch.
  let turnResults: ToolResultsMessage | undefined;
  let turnAssistantIndex: number | undefined;

  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        anthropicMessages.push({ role: "user", content: message.content || "[empty]" });
      } else {
        const parts: ContentBlock[] = [];

        for (const block of message.content) {
          if (block.type === "text") {
            if (block.text !== "") parts.push({ type: "text", text: block.text });
          } else if (block.data !== "" && block.mimeType !== "") {
            parts.push(imageBlock(block));
          }
        }

        anthropicMessages.push({ role: "user", content: parts.length > 0 ? parts : "[image]" });
      }
    } else if (message.role === "assistant") {
      const blocks: ContentBlock[] = [];

      for (const block of message.content) {
        // Widened first so a block outside pi's types is still counted below.
        const blockType: string = block.type;

        if (block.type === "text") {
          if (block.text !== "") blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          // Only thinking Claude Code itself produced is replayed. A signature minted by
          // any other provider, pi's own Anthropic provider included, is not ours to hand
          // back, and Anthropic rejects ones it cannot verify.
          const signature = block.thinkingSignature;

          if (message.provider === PROVIDER_ID && signature !== undefined && signature !== "") {
            blocks.push({ type: "thinking", thinking: block.thinking, signature });
          } else {
            dropped.thinking++;
            dropped.providers.add(message.provider);
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: sanitizeToolId(block.id, sanitizedIds),
            name: mapPiToolNameToSdk(block.name, toSdk),
            input: block.arguments,
          });
        } else {
          dropped.other.set(blockType, (dropped.other.get(blockType) ?? 0) + 1);
        }
      }

      // A turn aborted before anything streamed has no content. A placeholder would
      // invent a reply the assistant never made, early in the prefix, costing the whole
      // downstream prompt cache on every rebuild. Session.importMessages imposes no
      // alternation, and an empty turn has no tool_use ids needing a result.
      //
      // turnResults/turnAssistantIndex are deliberately not cleared: an abort between
      // two parallel results (assistant[X,Y], R_X, aborted turn, R_Y) would otherwise
      // start a second results message for R_Y, and repairToolPairing would stub Y at
      // the first one and drop the real R_Y.
      if (message.content.length === 0) {
        dropped.abortedTurns++;
        continue;
      }

      // Blocks were present but all were filtered: keep the slot and say so. Empty
      // content is rejected by the API, and dropping the message breaks tool pairing.
      if (blocks.length === 0)
        blocks.push({ type: "text", text: "[incompatible content omitted]" });

      turnResults = undefined;
      turnAssistantIndex = anthropicMessages.length;
      anthropicMessages.push({ role: "assistant", content: blocks });
    } else if (message.role === "toolResult") {
      // Pi records one message per tool result, but repairToolPairing only pairs results
      // that share the user message directly after their assistant message: split
      // across messages, every result past the first was replaced with "[no tool result
      // recorded]". Session.importMessages applies that repair itself, so the turn's
      // results are collected into one message placed directly after the assistant
      // message. That also keeps a steer landing mid-execution (which pi records between
      // results) from taking the stubs. Claude Code normalizes to the same order: it
      // re-inserts a mid-turn steer after the nearest tool_result.
      const block: ContentBlock = {
        type: "tool_result",
        tool_use_id: sanitizeToolId(message.toolCallId, sanitizedIds),
        content: toolResultContent(message.content),
        is_error: message.isError,
      };

      if (turnResults === undefined) {
        turnResults = { role: "user", content: [block] };
        // A result with no assistant message before it is malformed; appending keeps it
        // in order for repairToolPairing to discard.
        anthropicMessages.splice(
          turnAssistantIndex === undefined ? anthropicMessages.length : turnAssistantIndex + 1,
          0,
          turnResults,
        );
      } else {
        turnResults.content.push(block);
      }
    }
  }

  return { anthropicMessages, sanitizedIds, dropped };
}
