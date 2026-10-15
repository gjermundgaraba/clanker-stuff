// The pi sessions one load of the extension serves: each session's cwd, the UI its
// notices go to, and its Claude Code conversation. Provider registrations belong to the
// runtime that loaded the extension, so this state does too. A pi restart starts empty;
// its first turn rebuilds.

import { safeText } from "@clanker-stuff/pi-tool-rendering/text";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createActor, waitFor } from "xstate";
import type { Actor } from "xstate";

import type { QueryFunction } from "./child.js";
import { debug } from "./log.js";
import { conversationMachine } from "./machine/conversation.js";
import type { ConversationSnapshot } from "./machine/conversation.js";

export type Conversation = Actor<typeof conversationMachine>;

interface PiSession {
  /** A host serving many sessions from one process (pi-web) has one process cwd, so
   *  Claude Code would otherwise run in, and load from, the host's directory. */
  cwd?: string;
  ui?: ExtensionUIContext;
  conversation?: Conversation;
}

export class Sessions {
  private readonly byId = new Map<string, PiSession>();

  constructor(private readonly run: QueryFunction) {}

  start(piSessionId: string, cwd: string, ui?: ExtensionUIContext): void {
    this.byId.set(piSessionId, {
      ...this.byId.get(piSessionId),
      cwd,
      ...(ui === undefined ? {} : { ui }),
    });
  }

  /** Forget a session, stopping its conversation and the query it runs. */
  end(piSessionId: string): void {
    this.byId.get(piSessionId)?.conversation?.stop();
    this.byId.delete(piSessionId);
  }

  cwd(piSessionId: string | undefined): string {
    return (
      (piSessionId === undefined ? undefined : this.byId.get(piSessionId)?.cwd) ?? process.cwd()
    );
  }

  /** Provider and Claude Code text reaches the terminal only sanitized. */
  notify(piSessionId: string | undefined, message: string): void {
    const ui = piSessionId === undefined ? undefined : this.byId.get(piSessionId)?.ui;

    if (ui === undefined) debug(`notice with no UI to show it: ${message}`);
    else ui.notify(safeText(message), "warning");
  }

  /** The session's conversation, started on its first request. */
  conversation(piSessionId: string): Conversation {
    const session = this.byId.get(piSessionId) ?? {};

    session.conversation ??= this.ephemeral(piSessionId);
    this.byId.set(piSessionId, session);

    return session.conversation;
  }

  /** A conversation no session keeps, for a one-off request. */
  ephemeral(piSessionId: string | undefined): Conversation {
    return createActor(conversationMachine, {
      input: { run: this.run, notify: (message) => this.notify(piSessionId, message) },
    }).start();
  }

  /** Stop every conversation. */
  clear(): void {
    for (const id of this.byId.keys()) this.end(id);
  }
}

/** The conversation once a finished query has exited: until then Claude Code is still
 *  writing the session file the next query resumes. */
export const settled = (conversation: Conversation): Promise<ConversationSnapshot> =>
  waitFor(conversation, (snapshot) => !snapshot.matches({ active: "closing" }));
