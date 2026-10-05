import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const skill = path.resolve(import.meta.dirname, "..");

const homes: string[] = [];

const fixture = () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-history-"));
  homes.push(home);

  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: "",
    CODEX_HOME: "",
    GROK_HOME: "",
    OPENCODE_DB: "",
  };

  const run = (args: string[], helper = path.join(skill, "scripts/find-transcripts.mjs")) =>
    spawnSync(helper, args, { cwd: home, env, encoding: "utf8" });

  return { home, run };
};

const directory = (location: string) => mkdirSync(location, { recursive: true });

const file = (location: string) => {
  directory(path.dirname(location));
  writeFileSync(location, "fixture");
};

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("transcript discovery CLI", () => {
  it.each([false, true])("executes directly with a folder symlink: %s", (linked) => {
    const { home, run } = fixture();
    const sessions = path.join(home, ".codex/sessions");
    directory(sessions);
    const installed = path.join(home, ".agents/skills/agent-history");
    directory(path.dirname(installed));
    symlinkSync(skill, installed, "dir");

    const result = run(
      ["--tool", "Codex"],
      path.join(linked ? installed : skill, "scripts/find-transcripts.mjs"),
    );

    const output: unknown = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expect(output).toEqual([{ tool: "Codex", locations: [sessions] }]);
  });

  it("derives selection and help from all thirteen tool records", () => {
    const { run } = fixture();
    const help = run(["--help"]);
    const line = help.stdout.split("\n").find((text) => text.startsWith("Tools:"));

    expect(help.status).toBe(0);
    expect(line?.split(",")).toHaveLength(13);
    expect(line).toContain("Warp CLI");
    expect(line).toContain("Claude Code");
    expect(run([])).toMatchObject({ status: 0, stdout: "[]\n", stderr: "" });
    expect(run(["--tool", "claude-code"])).toMatchObject({ status: 0, stdout: "[]\n", stderr: "" });
  });

  it.each([
    ["--tool"],
    ["--tool", ""],
    ["--tool", "--help"],
    ["--tool", "unknown"],
    ["--tool", "Codex", "extra"],
    ["--bad"],
    ["-h", "extra"],
  ])("rejects invalid request %j", (...args) => {
    const { run } = fixture();
    const result = run(args);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });

  it("combines the detected tools in stable order", () => {
    const { home, run } = fixture();
    const claude = path.join(home, ".claude/projects");
    const codex = path.join(home, ".codex/sessions");
    directory(codex);
    directory(claude);
    const result = run([]);
    const output: unknown = JSON.parse(result.stdout);

    expect(output).toEqual([
      { tool: "Claude Code", locations: [claude] },
      { tool: "Codex", locations: [codex] },
    ]);
  });

  it("keeps recursive discovery bounded and does not traverse symlinks", () => {
    const { home, run } = fixture();
    const storage = path.join(home, "Library/Application Support/Cursor/User/workspaceStorage");
    const database = path.join(storage, "workspace/state.vscdb");
    file(database);
    file(path.join(storage, "one/two/three/state.vscdb"));
    const external = path.join(home, "outside");
    file(path.join(external, "state.vscdb"));
    symlinkSync(external, path.join(storage, "linked"), "dir");
    const result = run(["--tool", "Cursor"]);
    const output: unknown = JSON.parse(result.stdout);

    expect(output).toEqual([{ tool: "Cursor", locations: [database] }]);
  });
});
