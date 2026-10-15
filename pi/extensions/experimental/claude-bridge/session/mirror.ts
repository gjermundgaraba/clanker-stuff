// Mirrors of the Claude Code conversations pi sessions run on, one per pi session.
//
// Claude Code resumes from its own JSONL session file, so before each fresh query the
// file must hold pi's history up to the current user turn. Two paths:
//   REUSE: pi's history only grew (or drifted by the trailing final assistant message
//     pi appends after the stream returns, which Claude Code's file already has). Resume
//     the existing session id; Claude Code's prompt cache stays warm.
//   REBUILD: no session yet, or pi's history diverged (an abort, /compact, tree
//     navigation, another provider took a turn). Write a fresh file holding all prior
//     messages, reusing the same session id where safe so ids stay stable for log
//     correlation. A full rewrite rather than a patch: injecting deltas creates a branch
//     Claude Code's --resume does not follow, and it re-reads the file on every resume.
//
// One mirror per pi session: a process serves several at once (subagents run their own
// AgentSessions), and a single shared slot let a length-matching foreign sync reuse or
// rebuild another session's file.

import { realpathSync, statSync } from "node:fs";

import type { Message } from "@earendil-works/pi-ai";
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io";
import type { Session } from "cc-session-io";

import { debug, errorMessage, isDebugEnabled, debugLogPath, diagDump } from "../log.js";
import { nonSystemMessages } from "../prompt.js";
import { turnStart } from "../turn.js";
import { collectCarriedAttachments, placeCarriedAttachments } from "./attachments.js";
import type { CarriedAttachment } from "./attachments.js";
import { convertPiMessages } from "./convert.js";
import { verifyWrittenSession } from "./verify.js";

export interface SessionState {
  sessionId: string;
  cursor: number;
  cwd: string;
  /** The pi session this conversation serves: attribution for history rewrites. */
  piSessionId?: string | undefined;
  /** Force the next sync down REBUILD: pi changed its messages out from under us
   *  (compact, tree navigation), or an abort left the file indeterminate. */
  needsRebuild?: boolean | undefined;
  /** Set only where a Claude Code subprocess was just killed (an abort, or a query
   *  discarded because pi rewrote the history under it). The dying process may still
   *  flush a late record into the file, so REBUILD takes a fresh id and skips
   *  deleteSession, letting orphan writes land on a dead inode. A rewrite with no query
   *  in flight has no concurrent writer, so rebuilding in place is safe then. */
  forceRotate?: boolean | undefined;
}

export interface SyncResult {
  /** Session id to resume, or null to start clean. */
  sessionId: string | null;
  /** A clean start that must not replace this pi session's mirror when it completes. */
  preserveSharedSession?: boolean;
}

/** Unattributed calls (a host that omits the session id) share one bucket. */
const sessionKey = (piSessionId: string | null | undefined): string => piSessionId ?? "(none)";

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

export class SessionMirrors {
  private readonly states = new Map<string, SessionState>();

  /** Pi sessions whose history was replaced (compact, tree) rather than appended to.
   *  Read on the tool-result path, the one provider call that never syncs, so a query
   *  parked at a tool boundary is discarded rather than resumed. Real pi session ids
   *  only: no rewrite event is unattributed. */
  readonly rewritten = new Set<string>();

  /** @param warn surfaces a session-file integrity warning to the user. */
  constructor(private readonly warn: (message: string) => void) {}

  get size(): number {
    return this.states.size;
  }

  get(piSessionId: string | null | undefined): SessionState | undefined {
    return this.states.get(sessionKey(piSessionId));
  }

  set(piSessionId: string | null | undefined, state: SessionState | undefined): void {
    if (state === undefined) this.states.delete(sessionKey(piSessionId));
    else this.states.set(sessionKey(piSessionId), state);
  }

  /** Mark this session's mirror for REBUILD (and optionally rotation), if it has one. */
  markRebuild(piSessionId: string | null | undefined, rotate = false): SessionState | undefined {
    const state = this.get(piSessionId);

    if (state === undefined) return undefined;

    const next = { ...state, needsRebuild: true, ...(rotate ? { forceRotate: true } : {}) };

    this.set(piSessionId, next);

    return next;
  }

  clear(): void {
    this.states.clear();
    this.rewritten.clear();
  }

  /**
   * Make Claude Code's session file hold `messages` up to the current user turn.
   * Returns the session id to resume, or null for a clean start.
   */
  sync(
    messages: readonly Message[],
    cwd: string,
    toSdk: ReadonlyMap<string, string>,
    modelId: string,
    piSessionId: string | null,
  ): SyncResult {
    // System messages are prompt state, never imported, so they stay out of the history
    // space (priors, cursor, missed) everywhere below.
    const shared = this.get(piSessionId);
    const history = nonSystemMessages(messages);
    const priorMessages = history.slice(0, turnStart(history));

    // REUSE. A shorter incoming context cannot continue the cached session: without this
    // guard, missed = [].slice(cursor) would falsely reuse an unrelated longer session
    // after a pi-side rewrite.
    if (
      shared !== undefined &&
      shared.needsRebuild !== true &&
      priorMessages.length >= shared.cursor
    ) {
      const missed = priorMessages.slice(shared.cursor);
      const trailingAssistantOnly = missed.length === 1 && missed[0]?.role === "assistant";

      if (missed.length === 0 || trailingAssistantOnly) {
        if (trailingAssistantOnly) {
          this.set(piSessionId, { ...shared, cursor: priorMessages.length, cwd });
          debug(
            `Case 3: advanced cursor past trailing assistant, resuming session ${shared.sessionId.slice(0, 8)}, cursor=${priorMessages.length}`,
          );
        } else {
          debug(
            `Case 3: resuming session ${shared.sessionId.slice(0, 8)}, cursor=${shared.cursor}`,
          );
        }

        debug(`syncResult: path=reuse sessionId=${shared.sessionId}`);

        return { sessionId: shared.sessionId };
      }
    }

    // A pruned or short context on this session's own bucket cannot be a continuation:
    // start clean and leave the mirror alone. Only reachable without needsRebuild; every
    // user-facing rewrite sets it or clears the mirror first.
    if (
      shared !== undefined &&
      shared.needsRebuild !== true &&
      priorMessages.length < shared.cursor
    ) {
      debug(
        `Case 1 synthetic: clean start for shorter context, preserving shared session ${shared.sessionId.slice(0, 8)}, cursor=${shared.cursor}`,
      );
      debug(`syncResult: path=clean-start preserve-shared sessionId=${shared.sessionId}`);

      return { sessionId: null, preserveSharedSession: true };
    }

    // REBUILD
    if (priorMessages.length === 0) {
      debug(`Case 1: clean start, ${history.length} total messages`);
      debug("syncResult: path=clean-start");

      return { sessionId: null };
    }

    const previousSessionId = shared?.sessionId;
    // Rebuild in place unless a concurrent writer must not be raced.
    const preserveId = previousSessionId !== undefined && shared?.forceRotate !== true;

    // Before deleteSession, which wipes the file they live in.
    const carried =
      previousSessionId === undefined ? [] : readCarriedAttachments(previousSessionId, cwd);

    const dir = claudeDir();

    if (preserveId) deleteSession(previousSessionId, cwd, dir);

    const session = createSession({
      projectPath: cwd,
      model: modelId,
      ...(dir === undefined ? {} : { claudeDir: dir }),
      ...(preserveId ? { sessionId: previousSessionId } : {}),
    });

    importMessages(session, priorMessages, toSdk, carried);
    session.save();
    // Records, not messages: carried `@file` attachments are records too.
    this.verify(session.jsonlPath, session.sessionId, session.records.length, cwd);
    this.set(piSessionId, {
      sessionId: session.sessionId,
      cursor: priorMessages.length,
      cwd,
      piSessionId: piSessionId ?? undefined,
    });

    const id = session.sessionId.slice(0, 8);

    // "Case N" anchors are what the live suites and log audits grep for.
    if (previousSessionId === undefined) {
      debug(
        `Case 2: first turn with ${priorMessages.length} prior messages → session ${id}, ${session.records.length} records`,
      );
    } else if (preserveId) {
      debug(
        `Case 4: ${priorMessages.length - (shared?.cursor ?? 0)} missed messages, ${priorMessages.length} total → rewrote session ${id} (same id), ${session.records.length} records`,
      );
    } else {
      debug(
        `Case 4 post-abort: ${priorMessages.length} total → new session ${id} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.records.length} records`,
      );
    }

    debug(
      `syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`,
    );
    debugSessionPaths(session.sessionId.slice(0, 8), cwd, session.jsonlPath);

    return { sessionId: session.sessionId };
  }

  private verify(jsonlPath: string, sessionId: string, recordCount: number, cwd: string): void {
    for (const warning of verifyWrittenSession(jsonlPath, sessionId, recordCount)) {
      debug(`WARNING session verify: ${warning}`);
      diagDump("session_verify_fail", {
        warning,
        jsonlPath,
        cwd,
        realpath: safeRealpath(cwd),
        claudeConfigDir: claudeDir() ?? null,
      });
      this.warn(
        `Claude bridge session file issue: ${warning}\n` +
          `cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${claudeDir() ?? "(unset)"}\n` +
          (isDebugEnabled()
            ? `Details are in ${debugLogPath()}.`
            : "Rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log."),
      );
    }
  }
}
