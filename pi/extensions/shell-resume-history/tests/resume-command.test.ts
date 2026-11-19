import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { patchEnv } from "../../../tests/helpers/env.js";
import { createTempDir } from "../../../tests/helpers/fs.js";
import extension from "../index.js";
import {
  enqueueResumeHistory,
  INBOX_ENV,
  recordResumeCommand,
} from "../resume-command.js";

describe("resume command", () => {
  let tempRoot: string | undefined;
  let restoreEnv: (() => void) | undefined;

  const setup = async () => {
    tempRoot = await createTempDir("shell-resume-history-");
    const agentDir = path.join(tempRoot, "agent");
    const cwd = path.join(tempRoot, "project");
    const inbox = path.join(tempRoot, "inbox");
    await mkdir(inbox);
    restoreEnv = patchEnv({
      [INBOX_ENV]: inbox,
      PI_CODING_AGENT_DIR: agentDir,
    });

    return { cwd, inbox, tempRoot };
  };

  afterEach(async () => {
    restoreEnv?.();
    restoreEnv = undefined;

    if (tempRoot !== undefined) {
      await rm(tempRoot, { force: true, recursive: true });
      tempRoot = undefined;
    }
  });

  it("queues the exact persisted session path with its original project directory", async () => {
    const { cwd, inbox, tempRoot: root } = await setup();
    const sessionDir = path.join(root, "custom Pi's\nsessions\\directory");

    const sessionManager = SessionManager.create(cwd, sessionDir, {
      id: "full-session-id",
    });

    sessionManager.appendMessage(fauxAssistantMessage("test"));
    const host = createExtensionHost(extension);

    const ctx = host.createContext({
      cwd,
      sessionManager,
    });

    await host.emitSessionShutdown(ctx);

    const messages = await readdir(inbox);
    expect(messages).toHaveLength(1);
    const [message] = messages;
    assert.ok(message?.endsWith(".session-path") === true);
    const payload = await readFile(path.join(inbox, message), "utf-8");
    expect(payload).toBe(`${sessionManager.getSessionFile()}\0`);
    expect(SessionManager.open(payload.slice(0, -1)).getCwd()).toBe(cwd);
  });

  it("does not queue history for replacement sessions or non-TUI modes", async () => {
    const { cwd, inbox, tempRoot: root } = await setup();
    const sessionDir = path.join(root, "sessions");

    const sessionManager = SessionManager.create(cwd, sessionDir, {
      id: "full-session-id",
    });

    sessionManager.appendMessage(fauxAssistantMessage("test"));
    const sessionFile = sessionManager.getSessionFile();

    assert.ok(
      sessionFile !== undefined && sessionFile !== "",
      "Expected a persisted test session"
    );

    const host = createExtensionHost(() => {});

    await recordResumeCommand(
      "reload",
      host.createContext({ cwd, sessionManager })
    );
    await recordResumeCommand(
      "quit",
      host.createContext({ cwd, mode: "print", sessionManager })
    );

    await expect(readdir(inbox)).resolves.toStrictEqual([]);
  });

  it("lets pi quit when the inbox cannot be written", async () => {
    const { cwd, inbox } = await setup();
    await rm(inbox, { recursive: true });

    const sessionManager = SessionManager.create(cwd, undefined, {
      id: "full-session-id",
    });

    sessionManager.appendMessage(fauxAssistantMessage("test"));
    const host = createExtensionHost(extension);

    await expect(
      host.emitSessionShutdown(host.createContext({ cwd, sessionManager }))
    ).resolves.toBeUndefined();
  });

  it("does not queue in-memory sessions", async () => {
    const { cwd, inbox } = await setup();
    const host = createExtensionHost(() => {});

    const sessionManager = SessionManager.inMemory(cwd, {
      id: "full-session-id",
    });

    const ctx = host.createContext({
      cwd,
      sessionManager,
    });

    await recordResumeCommand("quit", ctx);

    await expect(readdir(inbox)).resolves.toStrictEqual([]);
  });

  it("publishes complete, separate path records", async () => {
    const { inbox } = await setup();

    await Promise.all([
      enqueueResumeHistory(inbox, "/first"),
      enqueueResumeHistory(inbox, "/second\npath"),
    ]);

    const messages = await readdir(inbox);
    expect(messages).toHaveLength(2);
    expect(
      messages.every((name) => name.endsWith(".session-path"))
    ).toBeTruthy();

    const contents = await Promise.all(
      messages.map(
        async (name) => await readFile(path.join(inbox, name), "utf-8")
      )
    );

    expect(contents.toSorted()).toStrictEqual(["/first\0", "/second\npath\0"]);
  });
});
