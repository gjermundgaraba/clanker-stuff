import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { Message } from "@earendil-works/pi-ai";
import { createSession, openSession } from "cc-session-io";
import type { ImportAttachment, Message as SessionMessage } from "cc-session-io";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { patchEnv } from "../../../../../tests/helpers/env.js";
import { createTempDir } from "../../../../../tests/helpers/fs.js";
import { rebuildSession } from "../../session/rebuild.js";
import { assistant, text, user } from "./messages.js";

const MODEL = "claude-haiku-5-5";

/** A Claude Code session file already on disk, as an earlier query would have left it. */
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

describe(rebuildSession, () => {
  let configDir: string;
  let cwd: string;
  let restoreEnv: () => void;
  let warnings: string[];

  beforeEach(async () => {
    configDir = await createTempDir("claude-bridge-config-");
    cwd = await createTempDir("claude-bridge-cwd-");
    restoreEnv = patchEnv({ CLAUDE_CONFIG_DIR: configDir });
    warnings = [];
  });

  afterEach(async () => {
    restoreEnv();
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  const rebuild = (priors: readonly Message[], previous?: string, rotate = false) =>
    rebuildSession(
      { priors, cwd, toSdk: new Map(), modelId: MODEL, previous, rotate },
      (message) => {
        warnings.push(message);
      },
    );

  const contents = (sessionId: string) =>
    openSession({ sessionId, projectPath: cwd }).messages.map((record) => record.message.content);

  it("writes a session holding every prior message", () => {
    const sessionId = rebuild([user("Hi"), assistant([text("Hello.")])]);

    expect(sessionId).toEqual(expect.any(String));
    expect(recordTypes(sessionId ?? "", cwd)).toEqual(["user", "assistant"]);
    expect(warnings).toEqual([]);
  });

  // Nothing to resume: Claude Code mints its own session for the prompt.
  it("starts clean with no priors, deleting the session it replaces", () => {
    const previous = seedSession(cwd, [{ role: "user", content: "Hi" }]);
    const oldFile = openSession({ sessionId: previous, projectPath: cwd }).jsonlPath;

    expect(rebuild([], previous)).toBeUndefined();
    expect(existsSync(oldFile)).toBe(false);
  });

  // With no query in flight nothing else writes the file, so the id stays stable for log
  // correlation.
  it("rewrites the previous session in place under the same id", () => {
    const previous = seedSession(cwd, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello." }] },
    ]);

    const sessionId = rebuild(
      [user("Summary of earlier work"), assistant([text("Ok.")])],
      previous,
    );

    expect(sessionId).toBe(previous);
    expect(contents(previous)).toEqual([
      "Summary of earlier work",
      [{ type: "text", text: "Ok." }],
    ]);
  });

  // A killed Claude Code process may still flush a late record into its file, so a
  // rotating rebuild takes a fresh id and leaves the old file for the orphan writer.
  it("rotates to a new id when the rebuild must not race a dying writer", () => {
    const previous = seedSession(cwd, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello." }] },
    ]);

    const oldFile = openSession({ sessionId: previous, projectPath: cwd }).jsonlPath;
    const sessionId = rebuild([user("Hi"), assistant([text("Hello.")])], previous, true);

    expect(sessionId).toEqual(expect.any(String));
    expect(sessionId).not.toBe(previous);
    expect(existsSync(oldFile)).toBe(true);
  });

  // The rebuilt file holds one line per record, and a carried `@file` expansion is an
  // `attachment` record that `session.messages` filters out. Counting messages told
  // every user who at-mentioned a file before switching providers that their session
  // was corrupt.
  it("carries an attachment across the rebuild without reporting a count mismatch", () => {
    const prompt = "Review @fixture.txt and remember it.";
    const fixture = path.join(cwd, "fixture.txt");

    const previous = seedSession(
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

    rebuild([user(prompt), assistant([text("Noted.")])], previous);

    expect(
      openSession({ sessionId: previous, projectPath: cwd }).attachments.map(
        (record) => record.attachment.filename,
      ),
    ).toEqual([fixture]);
    expect(warnings).toEqual([]);
  });
});
