import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import type { Message } from "@earendil-works/pi-ai";
import { getSessionPath } from "cc-session-io";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { debug } from "../log.js";
import { messageIdentity } from "../sync.js";

/** The custom entry type that records, in pi's session, the Claude Code session a pi
 *  session last left in a clean state. It never reaches the model. */
export const SESSION_ENTRY = "claude-bridge-session";

const SessionRecordSchema = Type.Object({
  session: Type.String({ minLength: 1 }),
  cwd: Type.String(),
  held: Type.Integer({ minimum: 1 }),
  digest: Type.String(),
  bytes: Type.Integer({ minimum: 0 }),
});

/** A Claude Code session a later process can resume instead of rebuilding: its id and
 *  project directory, how many of pi's messages it holds and their digest, and the size of
 *  its transcript when Claude Code exited, so a transcript written to since is refused. */
export type SessionRecord = Static<typeof SessionRecordSchema>;

export const historyDigest = (messages: readonly Message[]): string =>
  createHash("sha256")
    .update(JSON.stringify(messages.map(messageIdentity)))
    .digest("hex");

const claudeDir = (): string | undefined => process.env["CLAUDE_CONFIG_DIR"];

const transcriptBytes = (session: string, cwd: string): number | undefined => {
  try {
    return statSync(getSessionPath(session, cwd, claudeDir())).size;
  } catch {
    return undefined;
  }
};

/** The record of a Claude Code session that exited cleanly holding `held`, or undefined
 *  when its transcript cannot be read. */
export const sessionRecord = (
  session: string,
  cwd: string,
  held: readonly Message[]
): SessionRecord | undefined => {
  const bytes = transcriptBytes(session, cwd);

  return bytes === undefined || held.length === 0
    ? undefined
    : {
        session,
        cwd,
        held: held.length,
        digest: historyDigest(held),
        bytes,
      };
};

export const sameRecord = (
  left: SessionRecord | undefined,
  right: SessionRecord
): boolean =>
  left !== undefined &&
  left.session === right.session &&
  left.held === right.held &&
  left.digest === right.digest &&
  left.bytes === right.bytes;

/** The newest record among `entries`, which are a pi branch oldest first. Entries pi
 *  read from disk are untyped, so a record that does not check is skipped. */
export const latestRecord = (
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>
): SessionRecord | undefined => {
  for (const entry of entries.toReversed()) {
    if (
      entry.type === "custom" &&
      entry.customType === SESSION_ENTRY &&
      Value.Check(SessionRecordSchema, entry.data)
    ) {
      return entry.data;
    }
  }

  return undefined;
};

const refusal = (
  record: SessionRecord,
  cwd: string,
  held: readonly Message[]
): string | undefined => {
  if (record.cwd !== cwd) {
    return `it ran in ${record.cwd}`;
  }

  if (held.length !== record.held || historyDigest(held) !== record.digest) {
    return "pi's history no longer starts with what it holds";
  }

  return transcriptBytes(record.session, cwd) === record.bytes
    ? undefined
    : "its transcript changed or is gone";
};

/** The messages `record`'s session holds, when `history` starts with them, the request
 *  runs in the recorded project directory, and the transcript is as Claude Code left it.
 *  Undefined otherwise: the turn then rebuilds as it would without a record. */
export const adoptable = (
  record: SessionRecord,
  cwd: string,
  history: readonly Message[]
): Message[] | undefined => {
  const held = history.slice(0, record.held);
  const refused = refusal(record, cwd, held);

  debug(
    `warm: ${refused === undefined ? "adopting" : `not adopting (${refused})`} session ${record.session.slice(0, 8)} holding ${record.held} messages`
  );

  return refused === undefined ? held : undefined;
};
