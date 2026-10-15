// Each pi session's Claude Code conversation, kept process-wide so that whichever
// evaluation's stream function pi calls finds the same one. A pi restart starts empty;
// its first turn rebuilds.

import { safeText } from "@clanker-stuff/pi-tool-rendering/text";
import { createActor, waitFor } from "xstate";
import type { Actor } from "xstate";

import type { QueryFunction } from "./child.js";
import { debug } from "./log.js";
import { conversationMachine } from "./machine/conversation.js";
import type { ConversationSnapshot } from "./machine/conversation.js";
import { shared } from "./shared.js";

export type Conversation = Actor<typeof conversationMachine>;

/** Provider and Claude Code text reaches the terminal only sanitized. */
export function notifySession(piSessionId: string | undefined, message: string): void {
  const ui = piSessionId === undefined ? undefined : shared().uis.get(piSessionId);

  if (ui === undefined) debug(`notice with no UI to show it: ${message}`);
  else ui.notify(safeText(message), "warning");
}

/** A conversation no session keeps: a side call, or a call pi did not attribute. */
export const ephemeralConversation = (
  run: QueryFunction,
  piSessionId: string | undefined,
): Conversation =>
  createActor(conversationMachine, {
    input: { run, notify: (message) => notifySession(piSessionId, message) },
  }).start();

export function conversationFor(piSessionId: string, run: QueryFunction): Conversation {
  const { conversations } = shared();
  const existing = conversations.get(piSessionId);

  if (existing !== undefined) return existing;

  const conversation = ephemeralConversation(run, piSessionId);

  conversations.set(piSessionId, conversation);

  return conversation;
}

/** Stop a session's conversation, and the query it runs, when the session goes. */
export function endConversation(piSessionId: string): void {
  const { conversations } = shared();

  conversations.get(piSessionId)?.stop();
  conversations.delete(piSessionId);
}

/** The conversation once a finished query has exited: until then Claude Code is still
 *  writing the session file the next query resumes. */
export const settled = (conversation: Conversation): Promise<ConversationSnapshot> =>
  waitFor(conversation, (snapshot) => !snapshot.matches({ active: "closing" }));
