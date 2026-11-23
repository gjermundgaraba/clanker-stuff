import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { PROVIDER_ID } from "./session/convert.js";
import { BASH_TIMEOUT_SECONDS } from "./tools.js";

/** Gives a `bash` call that sets no timeout {@link BASH_TIMEOUT_SECONDS}, from pi's
 *  `tool_call` event, when the call is claude-bridge's: the session's branch holds the
 *  assistant message making it, which names its provider. */
export const giveBashTimeout = (
  event: ToolCallEvent,
  session: Pick<ExtensionContext["sessionManager"], "getBranch">
): void => {
  if (
    !isToolCallEventType("bash", event) ||
    event.input.timeout !== undefined
  ) {
    return;
  }

  const caller = session
    .getBranch()
    .findLast(
      (entry) => entry.type === "message" && entry.message.role === "assistant"
    );

  if (
    caller?.type === "message" &&
    caller.message.role === "assistant" &&
    caller.message.provider === PROVIDER_ID &&
    caller.message.content.some(
      (block) => block.type === "toolCall" && block.id === event.toolCallId
    )
  ) {
    event.input.timeout = BASH_TIMEOUT_SECONDS;
  }
};
