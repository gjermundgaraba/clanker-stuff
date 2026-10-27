import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import type { Message } from "@earendil-works/pi-ai";
import { createSession, openSession } from "cc-session-io";
import type { Message as SessionMessage } from "cc-session-io";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { patchEnv } from "../../../../../tests/helpers/env.js";
import { createTempDir } from "../../../../../tests/helpers/fs.js";
import { rebuildSession } from "../../session/rebuild.js";
import { assistant, text, user } from "./messages.js";

const MODEL = "claude-haiku-5-5";

/** A Claude Code session file already on disk, as an earlier query would have left it. */
const seedSession = (cwd: string, messages: SessionMessage[]): string => {
  const sessionId = randomUUID();
  const session = createSession({ sessionId, projectPath: cwd, model: MODEL });

  session.importMessages(messages);
  session.save();

  return sessionId;
};

const recordTypes = (sessionId: string, cwd: string): string[] =>
  openSession({ sessionId, projectPath: cwd }).records.map(
    (record) => record.type
  );

describe(rebuildSession, () => {
  let configDir: string;
  let cwd: string;
  let restoreEnv: () => void;

  beforeEach(async () => {
    configDir = await createTempDir("claude-bridge-config-");
    cwd = await createTempDir("claude-bridge-cwd-");
    restoreEnv = patchEnv({ CLAUDE_CONFIG_DIR: configDir });
  });

  afterEach(async () => {
    restoreEnv();
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  const rebuild = (priors: readonly Message[], previous?: string) =>
    rebuildSession({ priors, cwd, modelId: MODEL, previous });

  const contents = (sessionId: string) =>
    openSession({ sessionId, projectPath: cwd }).messages.map(
      (record) => record.message.content
    );

  it("writes a session holding every prior message", () => {
    const sessionId = rebuild([user("Hi"), assistant([text("Hello.")])]);

    expect(sessionId).toStrictEqual(expect.any(String));
    expect(recordTypes(sessionId ?? "", cwd)).toStrictEqual([
      "user",
      "assistant",
    ]);
  });

  // Nothing to resume: Claude Code mints its own session for the prompt.
  it("starts clean with no priors, deleting the session it replaces", () => {
    const previous = seedSession(cwd, [{ role: "user", content: "Hi" }]);

    const oldFile = openSession({
      sessionId: previous,
      projectPath: cwd,
    }).jsonlPath;

    expect(rebuild([], previous)).toBeUndefined();
    expect(existsSync(oldFile)).toBe(false);
  });

  // A killed Claude Code may still flush a late record into the old file, so the
  // rebuild never writes there.
  it("writes a new session and deletes the one it replaces", () => {
    const previous = seedSession(cwd, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello." }] },
    ]);

    const oldFile = openSession({
      sessionId: previous,
      projectPath: cwd,
    }).jsonlPath;

    const sessionId = rebuild(
      [user("Summary of earlier work"), assistant([text("Ok.")])],
      previous
    );

    expect(sessionId).toStrictEqual(expect.any(String));
    expect(sessionId).not.toBe(previous);
    expect(contents(sessionId ?? "")).toStrictEqual([
      "Summary of earlier work",
      [{ type: "text", text: "Ok." }],
    ]);
    expect(existsSync(oldFile)).toBe(false);
  });
});
