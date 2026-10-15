// Pi history → the Anthropic message shape Claude Code's session files hold.

import type {
  ImageContent,
  Message as PiMessage,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage } from "cc-session-io";

import { acceptedImageType, IMAGE_MARKER } from "../images.js";
import type { ImageMediaType } from "../images.js";
import { sdkToolName } from "../tools.js";

export const PROVIDER_ID = "claude-bridge";

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
  const existing = cache.get(id);

  if (existing !== undefined) return existing;

  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");

  cache.set(id, clean);

  return clean;
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

/** A content block of a user turn, as Claude Code reads it in a prompt or a session. */
export type UserBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };

/** An image Claude accepts, or a marker where one was. */
function imageBlock(block: ImageContent): UserBlock {
  const mediaType = acceptedImageType(block);

  return mediaType === undefined
    ? { type: "text", text: IMAGE_MARKER }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: block.data } };
}

/** A pi user message's content as blocks: its text, its images, and a marker for any
 *  block outside pi's types, so the model sees something was there. The same for a
 *  prompt, a steer and a rebuilt session. */
export function userBlocks(content: UserMessage["content"]): UserBlock[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];

  return content.flatMap((block): UserBlock[] => {
    // Widened first: an extension's off-type block still gets its marker.
    const blockType: string = block.type;

    if (block.type === "text") return block.text === "" ? [] : [{ type: "text", text: block.text }];

    if (block.type === "image") return [imageBlock(block)];

    return [{ type: "text", text: `[${blockType}]` }];
  });
}

// Tool results are flattened to text, which is how Claude Code stores most of them.
// Images have no text form, so a result carrying one keeps the block array shape (what
// Claude Code writes for screenshots).
function toolResultContent(
  content: readonly (TextContent | ImageContent)[],
): string | ContentBlock[] {
  return content.some((block) => block.type === "image")
    ? userBlocks([...content])
    : messageContentToText(content);
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

export function convertPiMessages(messages: readonly PiMessage[]): ConvertedMessages {
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
      const blocks = userBlocks(message.content);

      // A string stays a string: that is how Claude Code stores a typed prompt.
      anthropicMessages.push({
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content || "[empty]"
            : blocks.length > 0
              ? blocks
              : "[empty]",
      });
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
            name: sdkToolName(block.name),
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
