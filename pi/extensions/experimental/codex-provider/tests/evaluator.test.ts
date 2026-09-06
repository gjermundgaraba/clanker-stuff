import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  applyExecutionOutcome,
  codexArguments,
  command,
  runJsonProcess,
  writeJsonReport,
} from "../scripts/evaluate-agents.ts";
import type { WireRecord } from "../scripts/wire.ts";

describe("agent evaluator infrastructure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("waits for stdio close after process exit and clears its timeout", async () => {
    vi.useFakeTimers();
    const events: WireRecord[] = [];
    const trailingEvent = { type: "tail", text: "😀" };
    const descendant = `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(trailingEvent))}), 50);`;
    const result = await runJsonProcess(
      process.execPath,
      [
        "-e",
        `
          let input = "";
          process.stdin.setEncoding("utf8").on("data", chunk => { input += chunk; });
          process.stdin.on("end", () => {
            console.log("startup warning");
            console.log(JSON.stringify({ type: "input", input }));
            process.stderr.write("discarded diagnostic");
            const child = require("node:child_process").spawn(
              process.execPath, ["-e", ${JSON.stringify(descendant)}],
              { stdio: ["ignore", 1, 2] }
            );
            child.unref();
          });
        `,
      ],
      process.cwd(),
      process.env,
      "test input €\n",
      1000,
      (event) => events.push(event),
    );

    expect(result).toStrictEqual({ exitCode: 0, timedOut: false });
    expect(events).toStrictEqual([{ type: "input", input: "test input €\n" }, trailingEvent]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("rejects a spawn error and immediately clears its timeout", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(path.join(tmpdir(), "codex-evaluator-spawn-"));
    try {
      await expect(
        runJsonProcess(
          path.join(directory, "missing-executable"),
          [],
          directory,
          process.env,
          "",
          1000,
          () => {},
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test.each([false, true])(
    "preserves timeout escalation and cleans up timers (ignores SIGTERM: %s)",
    async (ignoreTermination) => {
      vi.useFakeTimers();
      const ready = Promise.withResolvers<void>();
      const result = runJsonProcess(
        process.execPath,
        [
          "-e",
          `
            process.on("SIGTERM", () => { ${ignoreTermination ? "" : "process.exit(0);"} });
            setTimeout(() => process.exit(2), 10_000);
            console.log(JSON.stringify({ type: "ready" }));
          `,
        ],
        process.cwd(),
        process.env,
        "",
        25,
        () => ready.resolve(),
      );
      await ready.promise;
      await vi.advanceTimersByTimeAsync(25);
      if (ignoreTermination) {
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(5000);
      }
      await expect(result).resolves.toStrictEqual({
        exitCode: ignoreTermination ? null : 0,
        timedOut: true,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test("configures every resumed Codex turn with a writable sandbox", () => {
    const initial = codexArguments("gpt-5.6-sol", "high", "/fixture", 0);
    const resumed = codexArguments("gpt-5.6-sol", "high", "/fixture", 1);

    expect(initial.slice(0, 1)).toStrictEqual(["exec"]);
    expect(resumed.slice(0, 4)).toStrictEqual(["exec", "resume", "--last", "--json"]);
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

    expect(applyExecutionOutcome(passingTests, false, false, false).passed).toBeFalsy();
    expect(applyExecutionOutcome(passingTests, true, false, false).passed).toBeTruthy();
    expect(applyExecutionOutcome(passingTests, true, true, false)).toMatchObject({
      compactionObserved: false,
      passed: false,
    });
  });

  test("keeps the previous complete report when a replacement cannot serialize", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-evaluator-test-"));
    const target = path.join(directory, "results.json");
    try {
      writeJsonReport(target, { results: ["complete"] });
      type Cyclic = { self?: Cyclic | undefined };
      const cyclic: Cyclic = {};
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
      process.cwd(),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toHaveLength(2 * 1024 * 1024);
  });
});
