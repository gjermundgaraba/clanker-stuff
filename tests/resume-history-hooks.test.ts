import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vite-plus/test";

const repoRoot = path.resolve(import.meta.dirname, "..");

const hooks = [
  ["claude/plugins/resume-history/resume-history.sh", "claude --resume"],
  ["codex/plugins/resume-history/scripts/resume-history.sh", "codex resume"],
] as const;

const newInbox = () => {
  const inbox = mkdtempSync(path.join(tmpdir(), "resume-history-"));
  onTestFinished(() => {
    rmSync(inbox, { force: true, recursive: true });
  });

  return inbox;
};

const runHook = (script: string, inbox: string, sessionId: string) =>
  spawnSync("bash", [path.join(repoRoot, script)], {
    env: { ...process.env, PI_SHELL_RESUME_HISTORY_DIR: inbox },
    input: JSON.stringify({ session_id: sessionId }),
  });

const queued = (inbox: string) =>
  readdirSync(inbox)
    .filter((name) => name.endsWith(".command"))
    .map((name) => readFileSync(path.join(inbox, name), "utf-8"));

describe.each(hooks)("the %s hook", (script, command) => {
  it("queues the resume command for a safe session ID", () => {
    const inbox = newInbox();

    expect(runHook(script, inbox, "abc-123").status).toBe(0);
    expect(queued(inbox)).toStrictEqual([`${command} abc-123\n`]);
    expect(readdirSync(inbox)).toHaveLength(1);
  });

  it("queues nothing for a session ID that is not a safe shell word", () => {
    const inbox = newInbox();

    expect(runHook(script, inbox, "abc; rm -rf /").status).toBe(0);
    expect(readdirSync(inbox)).toStrictEqual([]);
  });

  it("exits cleanly without an inbox", () => {
    expect(runHook(script, "", "abc-123").status).toBe(0);
  });
});
