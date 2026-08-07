import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  applyExecutionOutcome,
  codexArguments,
  command,
  writeJsonReport,
} from "../scripts/evaluate-agents.ts";

describe("agent evaluator infrastructure", () => {
  test("configures every resumed Codex turn with a writable sandbox", () => {
    const initial = codexArguments("gpt-5.6-sol", "high", "/fixture", 0);
    const resumed = codexArguments("gpt-5.6-sol", "high", "/fixture", 1);

    expect(initial.slice(0, 1)).toStrictEqual(["exec"]);
    expect(resumed.slice(0, 4)).toStrictEqual([
      "exec",
      "resume",
      "--last",
      "--json",
    ]);
    for (const args of [initial, resumed]) {
      const sandboxIndex = args.indexOf('sandbox_mode="workspace-write"');
      expect(args[sandboxIndex - 1]).toBe("--config");
    }
    expect(resumed).not.toContain("--sandbox");
  });

  test("cannot pass an arm whose runner failed or timed out", () => {
    const passingTests = {
      passed: true,
      protectedFilesIntact: true,
      tests: 3,
    };

    expect(
      applyExecutionOutcome(passingTests, false, false, false).passed
    ).toBeFalsy();
    expect(
      applyExecutionOutcome(passingTests, true, false, false).passed
    ).toBeTruthy();
    expect(
      applyExecutionOutcome(passingTests, true, true, false)
    ).toMatchObject({
      compactionObserved: false,
      passed: false,
    });
  });

  test("keeps the previous complete report when a replacement cannot serialize", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-evaluator-test-"));
    const target = path.join(directory, "results.json");
    try {
      writeJsonReport(target, { results: ["complete"] });
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;

      expect(() => writeJsonReport(target, cyclic)).toThrow(/circular/iu);
      expect(JSON.parse(readFileSync(target, "utf-8"))).toStrictEqual({
        results: ["complete"],
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("accepts command output larger than Node's default one-megabyte cap", () => {
    const result = command(
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
      process.cwd()
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toHaveLength(2 * 1024 * 1024);
  });
});
