// The current user turn: the trailing run of user messages not yet written into the
// Claude Code session. Everything before it is replayed as session history and
// everything from it on becomes the prompt; deriving both halves from one index keeps a
// message from landing in both (an extension can append a display-only user message
// after the real one, making the turn longer than one message).

import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";

import { debug } from "./log.js";
import { messageContentToText } from "./session/convert.js";

/** Index of the first message of the current user turn; messages.length when the last
 *  message is not a user message. */
export function turnStart(messages: readonly Message[]): number {
  let index = messages.length;

  while (index > 0 && messages[index - 1]?.role === "user") index--;

  return index;
}

function currentTurn(messages: readonly Message[]): UserMessage[] {
  return messages
    .slice(turnStart(messages))
    .flatMap((message) => (message.role === "user" ? [message] : []));
}

/** The current user turn as text, or undefined when the last message is not a user one. */
export function extractUserPrompt(messages: readonly Message[]): string | undefined {
  const turn = currentTurn(messages);

  if (turn.length === 0) return undefined;

  // Empties are dropped before joining so an all-empty turn yields "" and trips the
  // caller's empty-prompt guard rather than sending bare newlines.
  return turn
    .map((message) => messageContentToText(message.content))
    .filter((text) => text !== "")
    .join("\n");
}

/** The current user turn as content blocks, preserving images. Undefined when it has no
 *  images; the caller then sends the text prompt. */
export function extractUserPromptBlocks(
  messages: readonly Message[],
): ContentBlockParam[] | undefined {
  const turn = currentTurn(messages);

  if (turn.length === 0) return undefined;

  let hasImage = false;
  const blocks: ContentBlockParam[] = [];

  for (const message of turn) {
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;

    for (const block of content) {
      if (block.type === "text") {
        if (block.text !== "") blocks.push({ type: "text", text: block.text });
      } else if (block.data === "" || block.mimeType === "") {
        // Data-less image blocks do occur.
        debug(
          `image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`,
        );
      } else {
        const mediaType = IMAGE_MEDIA_TYPES.find((type) => type === block.mimeType);

        if (mediaType === undefined) {
          debug(`image block with unsupported mimeType ${block.mimeType}, skipping`);
          continue;
        }

        debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
        hasImage = true;
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: block.data },
        });
      }
    }
  }

  debug(
    `extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((block) => block.type).join(",")}`,
  );

  return hasImage ? blocks : undefined;
}

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/** The trailing user turn as content blocks, or undefined when there is none. Blocks
 *  rather than text so image steers keep their images. */
export function steerBlocks(messages: readonly Message[]): ContentBlockParam[] | undefined {
  const blocks = extractUserPromptBlocks(messages);

  if (blocks !== undefined) return blocks;

  const text = extractUserPrompt(messages);

  return text === undefined || text === "" ? undefined : [{ type: "text", text }];
}
