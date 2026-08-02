import { execFileSync, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import { patchEnv } from "../../tests/helpers/env.js";
import { createTempDir } from "../../tests/helpers/fs.js";
import extension, {
  enqueueResumeCommand,
  formatResumeCommand,
  getDefaultSessionDirectory,
  INBOX_ENV,
} from "../index.js";

const hasCommand = (command: string) =>
  spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;

describe("shell resume history", () => {
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
    const sessionDir = getDefaultSessionDirectory(cwd);
    const sessionFile = path.join(sessionDir, "session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "{}\n");
    const host = createExtensionHost(extension);
    const ctx = host.createContext({
      cwd,
      sessionManager: {
        getSessionDir: () => sessionDir,
        getSessionFile: () => sessionFile,
        getSessionId: () => "full-session-id",
      } as never,
    });

    await host.emitSessionShutdown(ctx);

    const messages = await readdir(inbox);
    expect(messages).toHaveLength(1);
    await expect(
      readFile(path.join(inbox, messages[0]), "utf-8")
    ).resolves.toBe("pi --session full-session-id\n");
  });

  it("quotes a custom session directory", async () => {
    const { cwd } = await setup();
    const sessionDir = path.join(tempRoot ?? "", "custom pi's sessions");
    const sessionFile = path.join(sessionDir, "session.jsonl");
    await mkdir(sessionDir);
    await writeFile(sessionFile, "{}\n");

    expect(
      formatResumeCommand({
        cwd,
        sessionDir,
        sessionFile,
        sessionId: "full-session-id",
      })
    ).toBe(
      `pi --session-dir '${sessionDir.replaceAll("'", String.raw`'\''`)}' --session full-session-id`
    );
  });

  it("does not queue history for replacement sessions or non-TUI modes", async () => {
    const { cwd, inbox } = await setup();
    const sessionDir = getDefaultSessionDirectory(cwd);
    const sessionFile = path.join(sessionDir, "session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "{}\n");
    const host = createExtensionHost(extension);
    const sessionManager = {
      getSessionDir: () => sessionDir,
      getSessionFile: () => sessionFile,
      getSessionId: () => "full-session-id",
    } as never;

    await host.emitSessionShutdown(
      host.createContext({ cwd, sessionManager }),
      "reload"
    );
    await host.emitSessionShutdown(
      host.createContext({ cwd, mode: "print", sessionManager })
    );

    await expect(readdir(inbox)).resolves.toStrictEqual([]);
  });

  it("does not queue missing session files", async () => {
    const { cwd, inbox } = await setup();
    const host = createExtensionHost(extension);
    const ctx = host.createContext({
      cwd,
      sessionManager: {
        getSessionDir: () => getDefaultSessionDirectory(cwd),
        getSessionFile: () => path.join(cwd, "missing-session.jsonl"),
        getSessionId: () => "full-session-id",
      } as never,
    });

    await host.emitSessionShutdown(ctx);

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
      messages.map((name) => readFile(path.join(inbox, name), "utf-8"))
    );
    expect(contents.toSorted()).toStrictEqual([
      "pi --session first\n",
      "pi --session second\n",
    ]);
  });

  it.skipIf(!hasCommand("fish"))(
    "fish uses a private inbox and imports queued commands",
    async () => {
      await setup();
      const script = path.resolve(
        import.meta.dirname,
        "..",
        "shell",
        "fish.fish"
      );
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
        }
      );

      const [shellInbox, historyEntry] = output.trim().split("\n");
      expect(historyEntry).toBe(command);
      await expect(access(shellInbox)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  );

  it.skipIf(!hasCommand("zsh"))(
    "zsh uses a private inbox and imports queued commands",
    async () => {
      await setup();
      const script = path.resolve(
        import.meta.dirname,
        "..",
        "shell",
        "zsh.zsh"
      );
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
        }
      );

      const [shellInbox, historyEntry] = output.trim().split("\n");
      expect(historyEntry).toBe(command);
      await expect(access(shellInbox)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  );
});
