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
import type { Adoption, SessionRecord } from "./session/warm.js";

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
      ...(recorded === undefined ? {} : { recorded }),
    });
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

  /** The session's conversation, started on its first request: on the Claude Code
   *  session pi's session recorded, when that still holds the start of `history`. Each
   *  time it settles after Claude Code exited cleanly, a changed session is recorded. */
  conversation(piSessionId: string, history: readonly Message[]): Conversation {
    const session = this.byId.get(piSessionId) ?? {};

    if (session.conversation === undefined) {
      const conversation = this.started(
        piSessionId,
        session.recorded === undefined
          ? undefined
          : adoptable(session.recorded, this.cwd(piSessionId), history)
      );

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
    return this.started(piSessionId, undefined);
  }

  private started(
    piSessionId: string | undefined,
    adopt: Adoption | undefined
  ): Conversation {
    return createActor(conversationMachine, {
      input: {
        run: this.run,
        notify: (message) => {
          this.notify(piSessionId, message);
        },
        ...(adopt === undefined ? {} : { adopt }),
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
