import { safeText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createActor, waitFor } from "xstate";
import type { Actor } from "xstate";

import type { QueryFunction } from "./child.js";
import { debug } from "./log.js";
import { conversationMachine } from "./machine/conversation.js";
import type { ConversationSnapshot } from "./machine/conversation.js";
import { adoptable, sameRecord, sessionRecord } from "./session/warm.js";
import type { SessionRecord } from "./session/warm.js";

export type Conversation = Actor<typeof conversationMachine>;

/** Keeps a record of a session's Claude Code session in pi's session. */
export type RecordSession = (
  piSessionId: string,
  record: SessionRecord
) => void;

interface PiSession {
  cwd?: string;
  ui?: ExtensionUIContext;
  conversation?: Conversation;
  recordToAdopt?: SessionRecord;
  recorded?: SessionRecord;
}

export class Sessions {
  private readonly byId = new Map<string, PiSession>();

  private readonly run: QueryFunction;

  private readonly record: RecordSession;

  constructor(run: QueryFunction, record: RecordSession) {
    this.run = run;
    this.record = record;
  }

  start(
    piSessionId: string,
    cwd: string,
    ui?: ExtensionUIContext,
    recorded?: SessionRecord
  ): void {
    this.byId.set(piSessionId, {
      ...this.byId.get(piSessionId),
      cwd,
      ...(ui === undefined ? {} : { ui }),
      ...(recorded === undefined ? {} : { recordToAdopt: recorded, recorded }),
    });
  }

  /** Seeds a session's conversation with the Claude Code session pi's session recorded,
   *  when no query has run yet and that session still holds the start of `history`.
   *  Only the session's first request tries. */
  adoptRecorded(piSessionId: string, history: readonly Message[]): void {
    const session = this.byId.get(piSessionId);
    const record = session?.recordToAdopt;

    if (session === undefined || record === undefined) {
      return;
    }

    delete session.recordToAdopt;

    const conversation = this.conversation(piSessionId);
    const { context } = conversation.getSnapshot();

    if (context.ccSessionId !== undefined || context.held.length > 0) {
      return;
    }

    const held = adoptable(record, this.cwd(piSessionId), history);

    if (held !== undefined) {
      conversation.send({ type: "pi.adopt", session: record.session, held });
    }
  }

  /** Forget a session, stopping its conversation and the query it runs. */
  end(piSessionId: string): void {
    this.byId.get(piSessionId)?.conversation?.stop();
    this.byId.delete(piSessionId);
  }

  cwd(piSessionId: string | undefined): string {
    return (
      (piSessionId === undefined
        ? undefined
        : this.byId.get(piSessionId)?.cwd) ?? process.cwd()
    );
  }

  /** Provider and Claude Code text reaches the terminal only sanitized. */
  notify(piSessionId: string | undefined, message: string): void {
    const ui =
      piSessionId === undefined ? undefined : this.byId.get(piSessionId)?.ui;

    if (ui === undefined) {
      debug(`notice with no UI to show it: ${message}`);
    } else {
      ui.notify(safeText(message), "warning");
    }
  }

  /** The session's conversation, started on its first request. Each time it settles
   *  after Claude Code exited cleanly, a changed session is recorded. */
  conversation(piSessionId: string): Conversation {
    const session = this.byId.get(piSessionId) ?? {};

    if (session.conversation === undefined) {
      const conversation = this.ephemeral(piSessionId);

      conversation.subscribe((snapshot) => {
        this.recordSettled(piSessionId, session, snapshot);
      });
      session.conversation = conversation;
    }

    this.byId.set(piSessionId, session);

    return session.conversation;
  }

  private recordSettled(
    piSessionId: string,
    session: PiSession,
    snapshot: ConversationSnapshot
  ): void {
    const { ccSessionId, held, adopted } = snapshot.context;

    if (!snapshot.matches("idle") || adopted || ccSessionId === undefined) {
      return;
    }

    const record = sessionRecord(ccSessionId, this.cwd(piSessionId), held);

    if (record === undefined || sameRecord(session.recorded, record)) {
      return;
    }

    session.recorded = record;

    try {
      this.record(piSessionId, record);
    } catch (error) {
      debug("warm: could not record the Claude Code session:", error);
    }
  }

  ephemeral(piSessionId: string | undefined): Conversation {
    return createActor(conversationMachine, {
      input: {
        run: this.run,
        notify: (message) => {
          this.notify(piSessionId, message);
        },
      },
    }).start();
  }
}

/** The conversation once a finished query has exited: until then Claude Code is still
 *  writing the session file the next query resumes. */
export const settled = async (
  conversation: Conversation
): Promise<ConversationSnapshot> =>
  await waitFor(
    conversation,
    (snapshot) => !snapshot.matches({ active: "closing" })
  );
