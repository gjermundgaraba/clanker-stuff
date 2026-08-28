import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { patchEnv } from "../../../tests/helpers/env.js";
import { createTempDir } from "../../../tests/helpers/fs.js";
import {
  enqueueResumeCommand,
  formatResumeCommand,
  INBOX_ENV,
  recordResumeCommand,
} from "../resume-command.js";

const hasCommand = (command: string) =>
  spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;

const resumeSession = (sessionManager: SessionManager) => ({
  getCwd: () => sessionManager.getCwd(),
  getSessionDir: () => sessionManager.getSessionDir(),
  getSessionFile: () => sessionManager.getSessionFile(),
  getSessionId: () => sessionManager.getSessionId(),
});

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
    return { agentDir, cwd, inbox };
  };

  afterEach(async () => {
    restoreEnv?.();
    restoreEnv = undefined;
    if (tempRoot) {
      await rm(tempRoot, { force: true, recursive: true });
      tempRoot = undefined;
    }
  });

  it("queues the current persisted session when pi quits", async () => {
    const { cwd, inbox } = await setup();
    const sessionManager = SessionManager.create(cwd, undefined, { id: "full-session-id" });
    sessionManager.appendMessage(fauxAssistantMessage("test"));
    const host = createExtensionHost(() => {});
    const ctx = host.createContext({
      cwd,
      sessionManager: resumeSession(sessionManager),
    });

    await recordResumeCommand("quit", ctx);

    const messages = await readdir(inbox);
    expect(messages).toHaveLength(1);
    await expect(readFile(path.join(inbox, messages[0]), "utf-8")).resolves.toBe(
      "pi --session full-session-id\n",
    );
  });

  it("quotes a custom session directory", async () => {
    const { cwd } = await setup();
    const sessionDir = path.join(tempRoot ?? "", "custom pi's sessions");
    const sessionManager = SessionManager.create(cwd, sessionDir, { id: "full-session-id" });
    sessionManager.appendMessage(fauxAssistantMessage("test"));

    expect(formatResumeCommand(sessionManager)).toBe(
      `pi --session-dir '${sessionDir.replaceAll("'", String.raw`'\''`)}' --session full-session-id`,
    );
  });

  it.each(["safe; touch /tmp/pwned", "target.jsonl"])(
    "uses the session file for unsafe or path-like ID %j",
    async (sessionId) => {
      const { cwd } = await setup();
      const sessionFile = path.join(tempRoot ?? "", "imported.jsonl");
      await writeFile(
        sessionFile,
        `${JSON.stringify({
          cwd,
          id: sessionId,
          timestamp: new Date().toISOString(),
          type: "session",
          version: 3,
        })}\n`,
      );

      expect(formatResumeCommand(SessionManager.open(sessionFile))).toBe(
        `pi --session ${sessionFile}`,
      );
    },
  );

  it("does not queue history for replacement sessions or non-TUI modes", async () => {
    const { cwd, inbox } = await setup();
    const sessionDir = path.join(tempRoot ?? "", "sessions");
    const sessionManager = SessionManager.create(cwd, sessionDir, { id: "full-session-id" });
    sessionManager.appendMessage(fauxAssistantMessage("test"));
    const sessionFile = sessionManager.getSessionFile();
    if (sessionFile === undefined) {
      throw new Error("Expected a persisted test session");
    }
    const host = createExtensionHost(() => {});

    await recordResumeCommand("reload", host.createContext({ cwd, sessionManager }));
    await recordResumeCommand("quit", host.createContext({ cwd, mode: "print", sessionManager }));

    await expect(readdir(inbox)).resolves.toStrictEqual([]);
  });

  it("does not queue in-memory sessions", async () => {
    const { cwd, inbox } = await setup();
    const host = createExtensionHost(() => {});
    const sessionManager = SessionManager.inMemory(cwd, { id: "full-session-id" });
    const ctx = host.createContext({
      cwd,
      sessionManager: resumeSession(sessionManager),
    });

    await recordResumeCommand("quit", ctx);

    await expect(readdir(inbox)).resolves.toStrictEqual([]);
  });

  it("publishes complete, separate message files", async () => {
    const { inbox } = await setup();

    await Promise.all([
      enqueueResumeCommand("pi --session first"),
      enqueueResumeCommand("pi --session second"),
    ]);

    const messages = await readdir(inbox);
    expect(messages).toHaveLength(2);
    expect(messages.every((name) => name.endsWith(".command"))).toBeTruthy();
    const contents = await Promise.all(
      messages.map((name) => readFile(path.join(inbox, name), "utf-8")),
    );
    expect(contents.toSorted()).toStrictEqual(["pi --session first\n", "pi --session second\n"]);
  });

  it.skipIf(!hasCommand("fish"))(
    "fish uses a private inbox and imports queued commands",
    async () => {
      await setup();
      const script = path.resolve(import.meta.dirname, "..", "shell", "fish.fish");
      const command = "pi --session fish-session";

      const output = execFileSync(
        "fish",
        [
          "--no-config",
          "--command",
          [
            "source $SCRIPT_PATH",
            "__pi_shell_resume_history_setup",
            "set parent_inbox $PI_SHELL_RESUME_HISTORY_DIR",
            "set child_inbox (fish --no-config --command 'source $SCRIPT_PATH; __pi_shell_resume_history_setup; echo $PI_SHELL_RESUME_HISTORY_DIR; __pi_shell_resume_history_cleanup')",
            "test $parent_inbox != $child_inbox; or exit 1",
            "echo $parent_inbox",
            "printf '%s\\n' $TEST_COMMAND >$parent_inbox/message.command",
            "__pi_shell_resume_history_drain",
            "builtin history search --case-sensitive --exact $TEST_COMMAND",
          ].join("; "),
        ],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            SCRIPT_PATH: script,
            TEST_COMMAND: command,
            fish_history: "",
          },
        },
      );

      const [shellInbox, historyEntry] = output.trim().split("\n");
      expect(historyEntry).toBe(command);
      await expect(access(shellInbox)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.skipIf(!hasCommand("zsh"))(
    "zsh uses a private inbox and imports queued commands",
    async () => {
      await setup();
      const script = path.resolve(import.meta.dirname, "..", "shell", "zsh.zsh");
      const command = "pi --session zsh-session";

      const output = execFileSync(
        "zsh",
        [
          "-f",
          "-i",
          "-c",
          [
            'source "$SCRIPT_PATH"',
            "parent_inbox=$PI_SHELL_RESUME_HISTORY_DIR",
            'child_inbox=$(zsh -f -c \'source "$SCRIPT_PATH"; __pi_shell_resume_history_setup; print -r -- "$PI_SHELL_RESUME_HISTORY_DIR"; __pi_shell_resume_history_cleanup\')',
            "[[ $parent_inbox != $child_inbox ]] || exit 1",
            'print -r -- "$parent_inbox"',
            'print -r -- "$TEST_COMMAND" >"$parent_inbox/message.command"',
            "__pi_shell_resume_history_drain",
            "fc -ln -1",
          ].join("; "),
        ],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            SCRIPT_PATH: script,
            TEST_COMMAND: command,
          },
        },
      );

      const [shellInbox, historyEntry] = output.trim().split("\n");
      expect(historyEntry).toBe(command);
      await expect(access(shellInbox)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
