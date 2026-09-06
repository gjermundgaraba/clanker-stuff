import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { TestEvent } from "node:test/reporters";

import { describe, expect, test } from "vite-plus/test";

import { runNodeTests } from "../scripts/run-node-tests.ts";
import summaryReporter from "../scripts/test-summary-reporter.ts";

describe("structured Node test grading", () => {
  test("reports only the cumulative summary, not individual file summaries", async () => {
    const fileSummary = {
      counts: {
        tests: 1,
        failed: 0,
        passed: 1,
        cancelled: 0,
        skipped: 0,
        suites: 0,
        todo: 0,
        topLevel: 1,
      },
      duration_ms: 1,
      file: "/test/one.test.js",
      success: true,
    };
    const cumulative = {
      ...fileSummary,
      counts: { ...fileSummary.counts, tests: 3, passed: 2, failed: 1, topLevel: 3 },
      file: undefined,
      success: false,
    };
    const events: TestEvent[] = [
      { type: "test:summary", data: fileSummary },
      { type: "test:summary", data: { ...fileSummary, file: "/test/two.test.js" } },
      { type: "test:summary", data: cumulative },
    ];

    const output: string[] = [];
    for await (const chunk of summaryReporter(Readable.from(events))) {
      output.push(chunk);
    }
    expect(output).toStrictEqual([`${JSON.stringify(cumulative)}\n`]);
  });

  test("grades multiple isolated files without scraping test output", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-node-grading-"));
    try {
      writeFileSync(
        path.join(directory, "one.test.mjs"),
        `
        import test from "node:test";
        globalThis.fixture = true;
        console.log("# tests 999\\n# pass 999");
        test("one", () => {});
      `,
      );
      writeFileSync(
        path.join(directory, "two.test.mjs"),
        `
        import assert from "node:assert/strict";
        import test from "node:test";
        test("isolated", () => assert.equal(globalThis.fixture, undefined));
        test("fails", () => assert.fail("grader failure detail"));
        test.skip("skips", () => {});
      `,
      );

      const result = runNodeTests(directory);
      expect(result.status).toBe(1);
      expect(result.summary).toMatchObject({
        counts: { tests: 4, passed: 2, failed: 1 },
        success: false,
      });
      expect(result.output).toContain("grader failure detail");
      expect(result.output).toContain("# tests 999");

      rmSync(path.join(directory, "two.test.mjs"));
      expect(runNodeTests(directory)).toMatchObject({
        status: 0,
        summary: { counts: { tests: 1, passed: 1, failed: 0 }, success: true },
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("does not invent a successful summary when its subprocess times out", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-node-timeout-"));
    try {
      writeFileSync(
        path.join(directory, "slow.test.mjs"),
        `
        import test from "node:test";
        test("slow", () => new Promise(resolve => setTimeout(resolve, 1000)));
      `,
      );
      expect(runNodeTests(directory, 1)).toMatchObject({ status: null, summary: undefined });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
