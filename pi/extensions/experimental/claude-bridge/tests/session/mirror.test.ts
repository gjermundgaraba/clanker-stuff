import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import { createSession, openSession } from "cc-session-io";
import type { ImportAttachment, Message as SessionMessage } from "cc-session-io";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { patchEnv } from "../../../../../tests/helpers/env.js";
import { createTempDir } from "../../../../../tests/helpers/fs.js";
import { SessionMirrors } from "../../session/mirror.js";
import { assistant, text, user } from "./messages.js";

const MODEL = "claude-haiku-5-5";

const system = (
  fields: Partial<Omit<SystemMessage, "role" | "timestamp">> = {},
): SystemMessage => ({
  role: "system",
  content: "",
  ...fields,
  timestamp: 0,
});

/** A Claude Code session file already on disk, as an earlier sync would have left it. */
function seedSession(
  cwd: string,
  messages: SessionMessage[],
  attachments: ImportAttachment[] = [],
): string {
  const sessionId = randomUUID();
  const session = createSession({ sessionId, projectPath: cwd, model: MODEL });

  session.importMessages(messages, { attachments });
  session.save();

  return sessionId;
}

const recordTypes = (sessionId: string, cwd: string): string[] =>
  openSession({ sessionId, projectPath: cwd }).records.map((record) => record.type);

describe("SessionMirrors.sync", () => {
  let configDir: string;
  let cwd: string;
  let restoreEnv: () => void;
  let warnings: string[];
  let mirrors: SessionMirrors;

  beforeEach(async () => {
    configDir = await createTempDir("claude-bridge-config-");
    cwd = await createTempDir("claude-bridge-cwd-");
    restoreEnv = patchEnv({ CLAUDE_CONFIG_DIR: configDir });
    warnings = [];
    mirrors = new SessionMirrors((message) => {
      warnings.push(message);
    });
  });

  afterEach(async () => {
    restoreEnv();
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  const sync = (messages: readonly Message[], piSessionId: string | null = null) =>
    mirrors.sync(messages, cwd, new Map(), MODEL, piSessionId);

  // The system prompt arrives as a leading system message. It is prompt state, not
  // history: a fresh session must take the clean-start path rather than rebuild a file
  // holding nothing, which made --resume fail with "No conversation found".
  it("starts clean when only a system message precedes the first user message", () => {
    expect(sync([system({ content: "You are Claude Code." }), user("Hello")])).toEqual({
      sessionId: null,
    });
    expect(mirrors.get(null)).toBeUndefined();
    expect(mirrors.size).toBe(0);
  });

  // Mid-conversation tool-loadout updates land in the transcript as system messages.
  // They must not inflate the cursor or be imported as history, or the next turn's reuse
  // check (priors >= cursor) fails and every turn rebuilds the session.
  it("keeps cursor arithmetic consistent when system messages punctuate the history", () => {
    const sessionId = seedSession(cwd, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello." }] },
    ]);

    mirrors.set(null, { sessionId, cursor: 2, cwd });

    const result = sync([
      user("Hi"),
      assistant([text("Hello.")]),
      system({ toolsAdded: [{ name: "grep", description: "", parameters: Type.Object({}) }] }),
      user("Next"),
    ]);

    expect(result).toEqual({ sessionId });
    expect(mirrors.get(null)).toEqual({ sessionId, cursor: 2, cwd });
    expect(recordTypes(sessionId, cwd)).toEqual(["user", "assistant"]);
    expect(warnings).toEqual([]);
  });

  // pi appends the final assistant message after the stream returns; Claude Code's file
  // already holds it, so the session is resumed and the cursor moves past it.
  it("resumes past the trailing assistant message pi appended", () => {
    const sessionId = seedSession(cwd, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello." }] },
    ]);

    mirrors.set(null, { sessionId, cursor: 1, cwd });

    expect(sync([user("Hi"), assistant([text("Hello.")]), user("Next")])).toEqual({ sessionId });
    expect(mirrors.get(null)).toEqual({ sessionId, cursor: 2, cwd });
    expect(recordTypes(sessionId, cwd)).toEqual(["user", "assistant"]);
  });

  // The guard that stops a reentrant subagent from resuming, and then overwriting, the
  // parent's session: a context shorter than the cursor starts fresh and leaves the
  // parent's mirror in place.
  it("starts a fresh session for a shorter context and preserves the existing mirror", () => {
    const main = { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 42, cwd };

    mirrors.set(null, main);

    expect(sync([user("Summarize this conversation.")])).toEqual({
      sessionId: null,
      preserveSharedSession: true,
    });
    expect(mirrors.get(null)).toEqual(main);
  });

  it("writes a first session holding every prior message", () => {
    const result = sync([user("Hi"), assistant([text("Hello.")]), user("Next")], "pi-session");

    expect(result.sessionId).toEqual(expect.any(String));

    const sessionId = result.sessionId ?? "";

    expect(mirrors.get("pi-session")).toEqual({
      sessionId,
      cursor: 2,
      cwd,
      piSessionId: "pi-session",
    });
    expect(recordTypes(sessionId, cwd)).toEqual(["user", "assistant"]);
    expect(warnings).toEqual([]);
  });

  // One process serves several pi sessions (subagents run their own). A length-matching
  // sync from another session must not reuse or rebuild this one's file.
  it("keeps each pi session's mirror separate", () => {
    const history = [user("Hi"), assistant([text("Hello.")]), user("Next")];
    const first = sync(history, "parent");
    const second = sync(history, "child");

    expect(second.sessionId).not.toBeNull();
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(mirrors.get("parent")?.sessionId).toBe(first.sessionId);
    expect(mirrors.size).toBe(2);
  });

  // A rewrite with no query in flight rebuilds in place, keeping the id stable for log
  // correlation.
  it("rebuilds a session marked for rebuild under the same id", () => {
    const sessionId = seedSession(cwd, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello." }] },
    ]);

    mirrors.set(null, { sessionId, cursor: 2, cwd });
    mirrors.markRebuild(null);

    const result = sync([user("Summary of earlier work"), assistant([text("Ok.")]), user("Next")]);

    expect(result).toEqual({ sessionId });
    expect(mirrors.get(null)).toEqual({ sessionId, cursor: 2, cwd });

    const rebuilt = openSession({ sessionId, projectPath: cwd }).messages.map(
      (record) => record.message.content,
    );

    expect(rebuilt).toEqual(["Summary of earlier work", [{ type: "text", text: "Ok." }]]);
  });

  // A killed Claude Code process may still flush a late record into its file, so a
  // rotating rebuild takes a fresh id and leaves the old file for the orphan writer.
  it("rotates to a new id when the rebuild must not race a dying writer", () => {
    const sessionId = seedSession(cwd, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello." }] },
    ]);

    const oldFile = openSession({ sessionId, projectPath: cwd }).jsonlPath;

    mirrors.set(null, { sessionId, cursor: 2, cwd });
    mirrors.markRebuild(null, true);

    const result = sync([user("Hi"), assistant([text("Hello.")]), user("Next")]);

    expect(result.sessionId).not.toBeNull();
    expect(result.sessionId).not.toBe(sessionId);
    expect(existsSync(oldFile)).toBe(true);
    expect(mirrors.get(null)).toEqual({
      sessionId: result.sessionId,
      cursor: 2,
      cwd,
    });
  });

  // The rebuilt file holds one line per record, and a carried `@file` expansion is an
  // `attachment` record that `session.messages` filters out. Counting messages told
  // every user who at-mentioned a file before switching providers that their session
  // was corrupt.
  it("reports no count mismatch when a rebuild carries an attachment", () => {
    const prompt = "Review @fixture.txt and remember it.";
    const fixture = path.join(cwd, "fixture.txt");

    const sessionId = seedSession(
      cwd,
      [
        { role: "user", content: prompt },
        { role: "assistant", content: [{ type: "text", text: "Noted." }] },
      ],
      [
        {
          afterIndex: 0,
          attachment: {
            type: "file",
            filename: fixture,
            content: { type: "text", file: { filePath: fixture, content: "token" } },
          },
        },
      ],
    );

    mirrors.set(null, { sessionId, cursor: 0, cwd });
    sync([user(prompt), assistant([text("Noted.")]), user("Now what did it say?")]);

    expect(
      openSession({ sessionId, projectPath: cwd }).attachments.map(
        (record) => record.attachment.filename,
      ),
    ).toEqual([fixture]);
    expect(warnings).toEqual([]);
  });
});
