// Claude Code resumes from its own JSONL session file, so a conversation pi's history
// moved away from (another provider's turns, compaction, tree navigation, an abort) is
// rewritten from that history before the next query resumes it. A full rewrite rather
// than a patch: appended records form a branch Claude Code's --resume does not follow,
// and it re-reads the file on every resume.

import { realpathSync, statSync } from "node:fs";

import type { Message } from "@earendil-works/pi-ai";
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io";
import type { Session } from "cc-session-io";

import { debug, errorMessage, isDebugEnabled, debugLogPath, diagDump } from "../log.js";
import { collectCarriedAttachments, placeCarriedAttachments } from "./attachments.js";
import type { CarriedAttachment } from "./attachments.js";
import { convertPiMessages } from "./convert.js";
import { verifyWrittenSession } from "./verify.js";

const claudeDir = (): string | undefined => process.env.CLAUDE_CONFIG_DIR;

function safeRealpath(file: string): string {
  try {
    return realpathSync(file);
  } catch (error) {
    return `<failed: ${errorMessage(error)}>`;
  }
}

// Where a session file was just written. Catches pi writing ~/.claude/projects/<X> while
// Claude Code reads <Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
  if (!isDebugEnabled()) return;

  const realCwd = safeRealpath(cwd);
  let size: number | undefined;

  try {
    size = statSync(jsonlPath).size;
  } catch {
    // Not written yet.
  }

  debug(`${label}: cwd=${cwd}`);

  if (realCwd !== cwd) {
    debug(`${label}: realpath(cwd)=${realCwd} (differs; Claude Code uses the resolved path)`);
  }

  debug(`${label}: jsonlPath=${jsonlPath} exists=${size !== undefined} size=${size ?? "-"}`);
  debug(
    `${label}: CLAUDE_CONFIG_DIR=${claudeDir() ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`,
  );
}

/**
 * Claude Code's `@file` expansions from the session about to be replaced. Must run before
 * `deleteSession`, which wipes the file they live in.
 */
function readCarriedAttachments(sessionId: string, cwd: string): CarriedAttachment[] {
  try {
    const dir = claudeDir();

    const previous = openSession({
      sessionId,
      projectPath: cwd,
      ...(dir === undefined ? {} : { claudeDir: dir }),
    });

    return collectCarriedAttachments(previous.records);
  } catch (error) {
    // A post-abort rebuild reads a file the killed subprocess may have been midway
    // through writing, and a truncated last line throws. Carrying none is what happened
    // before this existed, so the failure is bounded by the status quo.
    debug(`WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`, error);

    return [];
  }
}

// Lossy: only text, image, thinking and toolCall blocks survive, and thinking only when
// Claude Code minted its signature.
function importMessages(
  session: Session,
  messages: readonly Message[],
  toSdk: ReadonlyMap<string, string>,
  carried: readonly CarriedAttachment[],
): void {
  const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(messages, toSdk);

  debug(
    `importMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs:`,
    anthropicMessages
      .map(({ role, content }, index) =>
        typeof content === "string"
          ? `[${index}]${role}:text`
          : `[${index}]${role}:${content.map((block) => block.type).join("+")}`,
      )
      .join(" "),
  );

  // The roles line shows only what survived; name the losses.
  const droppedParts = [
    dropped.thinking > 0
      ? `${dropped.thinking} thinking (${[...dropped.providers].toSorted().join(", ")})`
      : "",
    dropped.abortedTurns > 0 ? `${dropped.abortedTurns} aborted turn(s)` : "",
    ...[...dropped.other].map(([type, count]) => `${count} ${type}`),
  ].filter((part) => part !== "");

  if (droppedParts.length > 0) debug(`importMessages: dropped ${droppedParts.join(", ")}`);

  if (sanitizedIds.size > 0) {
    debug(
      `importMessages: sanitized ${sanitizedIds.size} tool IDs:`,
      [...sanitizedIds]
        .map(([original, clean]) => (original === clean ? original : `${original}→${clean}`))
        .join(", "),
    );
  }

  // importMessages repairs internally too (idempotently); repaired here so attachments
  // are placed in the index space it reads. Attachments are links in Claude Code's uuid
  // chain, so they are written in order with the messages, not appended.
  const repaired = repairToolPairing(anthropicMessages);

  if (repaired.length !== anthropicMessages.length) {
    debug(
      `importMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`,
    );
  }

  const placed = carried.length > 0 ? placeCarriedAttachments(carried, repaired) : undefined;

  if (placed !== undefined && placed.skipped.length > 0) {
    debug(
      `importMessages: dropped ${placed.skipped.length} carried attachment(s): ${placed.skipped.join("; ")}`,
    );
  }

  if (repaired.length === 0) return;

  if (placed !== undefined && placed.attachments.length > 0) {
    debug(`importMessages: carrying ${placed.attachments.length} attachment(s) across the rebuild`);
    session.importMessages(repaired, { attachments: placed.attachments });
  } else {
    session.importMessages(repaired);
  }
}

export interface Rebuild {
  /** pi's history before the turn the query sends. */
  priors: readonly Message[];
  cwd: string;
  toSdk: ReadonlyMap<string, string>;
  modelId: string;
  /** The session the conversation resumed until now, if any. Nothing resumes it again,
   *  so it is deleted. A killed Claude Code may still flush a record into it afterwards;
   *  that leaves a stray file nobody resumes, never a write into the new session. */
  previous: string | undefined;
}

/** Write a new session holding `priors`. Returns its id, or undefined for a clean start:
 *  with no priors there is nothing to resume, and Claude Code mints its own session. */
export function rebuildSession(
  rebuild: Rebuild,
  warn: (message: string) => void,
): string | undefined {
  const { priors, cwd, previous } = rebuild;
  const dir = claudeDir();

  // Before the previous session is deleted: they live in its file.
  const carried =
    previous === undefined || priors.length === 0 ? [] : readCarriedAttachments(previous, cwd);

  if (previous !== undefined) discardSession(previous, cwd);

  if (priors.length === 0) return undefined;

  const session = createSession({
    projectPath: cwd,
    model: rebuild.modelId,
    ...(dir === undefined ? {} : { claudeDir: dir }),
  });

  importMessages(session, priors, rebuild.toSdk, carried);
  session.save();
  // Records, not messages: carried `@file` attachments are records too.
  verify(session.jsonlPath, session.sessionId, session.records.length, cwd, warn);

  debug(
    `rebuild: ${priors.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.records.length} records${previous === undefined ? "" : `, replacing ${previous.slice(0, 8)}`}`,
  );
  debugSessionPaths(session.sessionId.slice(0, 8), cwd, session.jsonlPath);

  return session.sessionId;
}

/** Delete a session nothing will resume again. */
export function discardSession(sessionId: string, cwd: string): void {
  try {
    deleteSession(sessionId, cwd, claudeDir());
  } catch (error) {
    debug(`WARNING: could not delete session ${sessionId.slice(0, 8)}:`, error);
  }
}

function verify(
  jsonlPath: string,
  sessionId: string,
  recordCount: number,
  cwd: string,
  warn: (message: string) => void,
): void {
  for (const warning of verifyWrittenSession(jsonlPath, sessionId, recordCount)) {
    debug(`WARNING session verify: ${warning}`);
    diagDump("session_verify_fail", {
      warning,
      jsonlPath,
      cwd,
      realpath: safeRealpath(cwd),
      claudeConfigDir: claudeDir() ?? null,
    });
    warn(
      `Claude bridge session file issue: ${warning}\n` +
        `cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${claudeDir() ?? "(unset)"}\n` +
        (isDebugEnabled()
          ? `Details are in ${debugLogPath()}.`
          : "Rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log."),
    );
  }
}
