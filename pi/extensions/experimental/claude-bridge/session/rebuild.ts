// Claude Code resumes from its own JSONL session file, so a conversation pi's history
// moved away from (another provider's turns, compaction, tree navigation, an abort) is
// written anew from that history before the next query resumes it. A full rewrite rather
// than a patch: appended records form a branch Claude Code's --resume does not follow,
// and it re-reads the file on every resume.

import type { Message } from "@earendil-works/pi-ai";
import { createSession, deleteSession, repairToolPairing } from "cc-session-io";
import type { Session } from "cc-session-io";

import { debug } from "../log.js";
import { convertPiMessages } from "./convert.js";

const claudeDir = (): string | undefined => process.env["CLAUDE_CONFIG_DIR"];

// Lossy: only text, image, thinking and toolCall blocks survive, and thinking only when
// Claude Code minted its signature.
const importMessages = (
  session: Session,
  messages: readonly Message[]
): void => {
  const { anthropicMessages, sanitizedIds, dropped } =
    convertPiMessages(messages);

  debug(
    `importMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs:`,
    anthropicMessages
      .map(({ role, content }, index) =>
        typeof content === "string"
          ? `[${index}]${role}:text`
          : `[${index}]${role}:${content.map((block) => block.type).join("+")}`
      )
      .join(" ")
  );

  // The roles line shows only what survived; name the losses.
  const droppedParts = [
    dropped.thinking > 0
      ? `${dropped.thinking} thinking (${[...dropped.providers].toSorted().join(", ")})`
      : "",
    dropped.abortedTurns > 0 ? `${dropped.abortedTurns} aborted turn(s)` : "",
    ...[...dropped.other].map(([type, count]) => `${count} ${type}`),
  ].filter((part) => part !== "");

  if (droppedParts.length > 0) {
    debug(`importMessages: dropped ${droppedParts.join(", ")}`);
  }

  if (sanitizedIds.size > 0) {
    debug(
      `importMessages: sanitized ${sanitizedIds.size} tool IDs:`,
      [...sanitizedIds]
        .map(([original, clean]) =>
          original === clean ? original : `${original}→${clean}`
        )
        .join(", ")
    );
  }

  // importMessages repairs too (idempotently); repaired here so the log shows what it did.
  const repaired = repairToolPairing(anthropicMessages);

  if (repaired.length !== anthropicMessages.length) {
    debug(
      `importMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`
    );
  }

  if (repaired.length > 0) {
    session.importMessages(repaired);
  }
};

export interface Rebuild {
  /** pi's history before the turn the query sends. */
  priors: readonly Message[];
  cwd: string;
  modelId: string;
  /** The session the conversation resumed until now, if any. Nothing resumes it again,
   *  so it is deleted. A killed Claude Code may still flush a record into it afterwards;
   *  that leaves a stray file nobody resumes, never a write into the new session. */
  previous: string | undefined;
}

/** Delete a session nothing will resume again. */
export const discardSession = (sessionId: string, cwd: string): void => {
  try {
    deleteSession(sessionId, cwd, claudeDir());
  } catch (error) {
    debug(`WARNING: could not delete session ${sessionId.slice(0, 8)}:`, error);
  }
};

/** Write a new session holding `priors`. Returns its id, or undefined for a clean start:
 *  with no priors there is nothing to resume, and Claude Code mints its own session. */
export const rebuildSession = ({
  priors,
  cwd,
  modelId,
  previous,
}: Rebuild): string | undefined => {
  if (previous !== undefined) {
    discardSession(previous, cwd);
  }

  if (priors.length === 0) {
    return undefined;
  }

  const dir = claudeDir();

  const session = createSession({
    projectPath: cwd,
    model: modelId,
    ...(dir === undefined ? {} : { claudeDir: dir }),
  });

  importMessages(session, priors);
  session.save();

  debug(
    `rebuild: ${priors.length} prior messages → session ${session.sessionId.slice(0, 8)} at ${session.jsonlPath}${previous === undefined ? "" : `, replacing ${previous.slice(0, 8)}`}`
  );

  return session.sessionId;
};
