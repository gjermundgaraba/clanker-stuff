import type {
  ImageContent,
  Message as PiMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage } from "cc-session-io";

import { debug } from "../log.js";
import { sdkToolName } from "../tools.js";

export const PROVIDER_ID = "claude-bridge";

const sanitizeToolId = (id: string, cache: Map<string, string>): string => {
  const existing = cache.get(id);

  if (existing !== undefined) {
    return existing;
  }

  const clean = id.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");

  cache.set(id, clean);

  return clean;
};

const IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/** A content block of a user turn, as Claude Code reads it in a prompt or a session. */
export type UserBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: (typeof IMAGE_MEDIA_TYPES)[number];
        data: string;
      };
    };

const imageBlock = (block: ImageContent): UserBlock => {
  const mediaType = IMAGE_MEDIA_TYPES.find((type) => type === block.mimeType);

  if (mediaType === undefined || block.data === "") {
    debug(
      `image block (${block.mimeType || "no mimeType"}) replaced by a marker`
    );

    return { type: "text", text: "[image]" };
  }

  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: block.data },
  };
};

/** Pi content as Claude's blocks: its text, its images, and a marker where the model
 *  must see something was there. An image Claude rejects (another media type, or no
 *  data) fails its request and every later one once it is in the session, so it becomes
 *  a marker, as does a block outside pi's types. The same for a prompt, a steer, a tool
 *  result and a rebuilt session. */
export const userBlocks = (content: UserMessage["content"]): UserBlock[] => {
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }

  return content.flatMap((block): UserBlock[] => {
    const blockType: string = block.type;

    if (block.type === "text") {
      return block.text === "" ? [] : [{ type: "text", text: block.text }];
    }

    if (block.type === "image") {
      return [imageBlock(block)];
    }

    return [{ type: "text", text: `[${blockType}]` }];
  });
};

const toolResultContent = (
  content: ToolResultMessage["content"]
): string | ContentBlock[] => {
  const blocks = userBlocks(content);

  const texts = blocks.flatMap((block) =>
    block.type === "text" ? [block.text] : []
  );

  return texts.length === blocks.length ? texts.join("\n") : blocks;
};

/** What conversion discarded, for the debug trace: a stripped thinking block and one that
 *  never existed convert to the same thing, so without this the loss is invisible. */
export interface DroppedContent {
  thinking: number;
  abortedTurns: number;
  providers: Set<string>;
  other: Map<string, number>;
}

interface ConvertedMessages {
  anthropicMessages: SessionMessage[];
  sanitizedIds: Map<string, string>;
  dropped: DroppedContent;
}

type ToolResultsMessage = SessionMessage & { content: ContentBlock[] };

export const convertPiMessages = (
  messages: readonly PiMessage[]
): ConvertedMessages => {
  const anthropicMessages: SessionMessage[] = [];
  const sanitizedIds = new Map<string, string>();

  const dropped: DroppedContent = {
    thinking: 0,
    abortedTurns: 0,
    providers: new Set(),
    other: new Map(),
  };

  let turnResults: ToolResultsMessage | undefined;
  let turnAssistantIndex: number | undefined;

  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        anthropicMessages.push({
          role: "user",
          content: message.content || "[empty]",
        });
      } else {
        const blocks = userBlocks(message.content);

        anthropicMessages.push({
          role: "user",
          content: blocks.length > 0 ? blocks : "[empty]",
        });
      }
    } else if (message.role === "assistant") {
      const blocks: ContentBlock[] = [];

      for (const block of message.content) {
        const blockType: string = block.type;

        if (block.type === "text") {
          if (block.text !== "") {
            blocks.push({ type: "text", text: block.text });
          }
        } else if (block.type === "thinking") {
          const signature = block.thinkingSignature;

          if (
            message.provider === PROVIDER_ID &&
            signature !== undefined &&
            signature !== ""
          ) {
            blocks.push({
              type: "thinking",
              thinking: block.thinking,
              signature,
            });
          } else {
            dropped.thinking += 1;
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

      if (message.content.length === 0) {
        dropped.abortedTurns += 1;
        continue;
      }

      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "[incompatible content omitted]" });
      }

      turnResults = undefined;
      turnAssistantIndex = anthropicMessages.length;
      anthropicMessages.push({ role: "assistant", content: blocks });
    } else if (message.role === "toolResult") {
      /* repairToolPairing pairs only the results in the user message directly after their
       * assistant message, so a turn's results share one message:
       * https://github.com/elidickinson/cc-session-io/blob/v0.4.0/src/repair.ts */
      const block: ContentBlock = {
        type: "tool_result",
        tool_use_id: sanitizeToolId(message.toolCallId, sanitizedIds),
        content: toolResultContent(message.content),
        is_error: message.isError,
      };

      if (turnResults === undefined) {
        turnResults = { role: "user", content: [block] };
        anthropicMessages.splice(
          turnAssistantIndex === undefined
            ? anthropicMessages.length
            : turnAssistantIndex + 1,
          0,
          turnResults
        );
      } else {
        turnResults.content.push(block);
      }
    }
  }

  return { anthropicMessages, sanitizedIds, dropped };
};
