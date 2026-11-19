import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, rm } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createTempDir } from "../../../tests/helpers/fs.js";

const sessionFile = `/tmp/Pi's\n\n${String.raw`\n\\session.jsonl`}\n`;

const enqueue = `
  const { enqueueResumeHistory } = await import(process.env.WRITER_URL);
  await enqueueResumeHistory(process.env.PI_SHELL_RESUME_HISTORY_DIR, process.env.SESSION_FILE);
`;

const shells = [
  {
    command: "fish",
    flags: ["--no-config", "--command"],
    drain: [
      'source "$SCRIPT_PATH"',
      "__pi_shell_resume_history_setup; or exit 1",
      'set parent_inbox "$PI_SHELL_RESUME_HISTORY_DIR"',
      'set child_inbox (fish --no-config --command \'source "$SCRIPT_PATH"; __pi_shell_resume_history_setup; echo "$PI_SHELL_RESUME_HISTORY_DIR"\')',
      'test -n "$child_inbox"; and test "$parent_inbox" != "$child_inbox"; or exit 1',
      'printf "%s\\0" "$parent_inbox"',
      '"$NODE" --input-type=module --eval "$ENQUEUE"; or exit 1',
      "__pi_shell_resume_history_drain",
      'builtin history search --null --case-sensitive --prefix -- "pi --session "',
    ],
    stub: "function pi; printf '%s\\0' $argv; end",
    quotedPath: String.raw`/tmp/Pi\'s\n\n\\n\\\\session.jsonl\n`,
  },
  {
    command: "zsh",
    flags: ["-f", "-i", "-c"],
    drain: [
      'source "$SCRIPT_PATH"',
      'parent_inbox="$PI_SHELL_RESUME_HISTORY_DIR"',
      'child_inbox=$(zsh -f -c \'source "$SCRIPT_PATH"; __pi_shell_resume_history_setup; print -r -- "$PI_SHELL_RESUME_HISTORY_DIR"; __pi_shell_resume_history_cleanup\')',
      "[[ -n $child_inbox && $parent_inbox != $child_inbox ]] || exit 1",
      'print -rN -- "$parent_inbox"',
      '"$NODE" --input-type=module --eval "$ENQUEUE" || exit 1',
      "__pi_shell_resume_history_drain",
      "zmodload zsh/parameter",
      'print -rN -- "${history[$HISTCMD]}"',
    ],
    stub: "pi() { printf '%s\\0' \"$@\"; }",
    quotedPath: String.raw`$'/tmp/Pi\'s\n\n\\n\\\\session.jsonl\n'`,
  },
];

describe("resume history shell hooks", () => {
  it.for(shells)(
    "$command quotes queued session paths from its private inbox into history",
    async ({ command, flags, drain, stub, quotedPath }, { skip }) => {
      if (spawnSync(command, ["--version"], { stdio: "ignore" }).status !== 0) {
        skip(`${command} is not installed`);
      }

      const root = await createTempDir("shell-resume-history-hook-");

      try {
        const options = {
          cwd: root,
          encoding: "utf-8",
          env: {
            ...process.env,
            ENQUEUE: enqueue,
            HISTFILE: "",
            NODE: process.execPath,
            SCRIPT_PATH: path.resolve(
              import.meta.dirname,
              "..",
              "shell",
              `${command}.${command}`
            ),
            SESSION_FILE: sessionFile,
            WRITER_URL: new URL("../resume-command.ts", import.meta.url).href,
            XDG_RUNTIME_DIR: root,
            ZDOTDIR: root,
            fish_history: "",
          },
        } as const;

        const output = execFileSync(
          command,
          [...flags, drain.join("; ")],
          options
        );

        const [inbox, ...entries] = output.split("\0");
        assert.ok(inbox !== undefined && inbox !== "");
        const fixtureCommand = `pi --session ${quotedPath}`;
        expect(entries).toStrictEqual([fixtureCommand, ""]);
        await expect(access(inbox)).rejects.toMatchObject({ code: "ENOENT" });

        const args = execFileSync(
          command,
          [...flags, `${stub}; ${fixtureCommand}`],
          options
        );

        expect(args).toBe(`--session\0${sessionFile}\0`);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  );
});
