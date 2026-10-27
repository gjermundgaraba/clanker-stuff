// The current user turn: the trailing run of user messages not yet written into the
// Claude Code session. Everything before it is replayed as session history and
// everything from it on becomes the prompt; deriving both halves from one index keeps a
// message from landing in both (an extension can append a display-only user message
// after the real one, making the turn longer than one message).

import type { Message } from "@earendil-works/pi-ai";

import { userBlocks } from "./session/convert.js";
import type { UserBlock } from "./session/convert.js";

/** Index of the first message of the current user turn; messages.length when the last
 *  message is not a user message. */
export const turnStart = (messages: readonly Message[]): number => {
  let index = messages.length;

  while (index > 0 && messages[index - 1]?.role === "user") {
    index -= 1;
  }

  return index;
};

/** The trailing user turn as content blocks, or undefined when it has none: the prompt a
 *  query opens with, or a steer. */
export const userTurnBlocks = (
  messages: readonly Message[]
): UserBlock[] | undefined => {
  const blocks = messages
    .slice(turnStart(messages))
    .flatMap((message) =>
      message.role === "user" ? userBlocks(message.content) : []
    );

  return blocks.length > 0 ? blocks : undefined;
};
