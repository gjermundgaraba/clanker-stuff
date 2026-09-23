import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import * as codingAgent from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { boundRuntimeToolResult } from "../code-mode/trace-values.js";
import { MAX_DIFF_CHARS } from "../tools/patch.js";
import { ProcessManager } from "../tools/process.js";
import { registerFallbackCodexTools } from "./tool-fixtures.js";
import { createToolsModel } from "./fixtures.js";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Observes Pi helpers without replacing them; Pi exposes no seam.
vi.mock(import("@earendil-works/pi-coding-agent"), { spy: true });

const tempDirectories: string[] = [];

const ChangesSchema = Type.Object({
  changes: Type.Array(
    Type.Object({
      changed: Type.Boolean(),
      from: Type.Optional(Type.String()),
      kind: Type.String(),
      lines: Type.Optional(Type.Object({ added: Type.Number(), removed: Type.Number() })),
      path: Type.String(),
    }),
  ),
  diffs: Type.Array(Type.Object({ diff: Type.String(), index: Type.Integer() })),
});

const SessionDetailsSchema = Type.Object({
  running: Type.Optional(Type.Boolean()),
  sessionId: Type.Optional(Type.Number()),
  status: Type.Optional(Type.String()),
});

const OutputDetailsSchema = Type.Object({
  fullOutputPath: Type.Optional(Type.String()),
  truncation: Type.Optional(Type.Object({ truncated: Type.Boolean() })),
});

const createTempDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-tools-"));
  tempDirectories.push(directory);

  return directory;
};

const textContent = (
  result: Awaited<ReturnType<ReturnType<typeof createExtensionHost>["runTool"]>>,
) =>
  result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

describe("profile execution", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirectories.splice(0).map(async (directory) => {
        await rm(directory, { force: true, recursive: true });
      }),
    );
  });
  it("applies Codex add, update, move, and delete patches", async () => {
    const cwd = await createTempDirectory();
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(registerFallbackCodexTools, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    await host.runTool(
      "apply_patch",
      {
        patch: ["*** Begin Patch", "*** Add File: example.txt", "+hello", "*** End Patch"].join(
          "\n",
        ),
      },
      ctx,
    );
    await writeFile(path.join(cwd, "delete.txt"), "remove me\n", "utf-8");
    await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: example.txt",
          "*** Move to: moved.txt",
          "@@",
          "-hello",
          "+world",
          "*** Delete File: delete.txt",
          "*** End Patch",
        ].join("\n"),
      },
      ctx,
    );

    await expect(readFile(path.join(cwd, "moved.txt"), "utf-8")).resolves.toBe("world\n");
    await expect(readFile(path.join(cwd, "example.txt"), "utf-8")).rejects.toThrow("ENOENT");
    await expect(readFile(path.join(cwd, "delete.txt"), "utf-8")).rejects.toThrow("ENOENT");
  });

  it.skipIf(process.platform === "win32")(
    "deletes non-regular files without reading them and records only regular-file diffs",
    async () => {
      const cwd = await createTempDirectory();
      execFileSync("mkfifo", [path.join(cwd, "pipe")]);
      await writeFile(path.join(cwd, "plain.txt"), "one\ntwo\n", "utf-8");
      const model = createToolsModel("gpt-5.6-terra", true);
      const host = createExtensionHost(registerFallbackCodexTools, { model });
      const ctx = host.createContext({ cwd, model });
      await host.emitSessionStart(ctx);

      const result = await Promise.race([
        host.runTool(
          "apply_patch",
          {
            patch: [
              "*** Begin Patch",
              "*** Delete File: pipe",
              "*** Delete File: plain.txt",
              "*** End Patch",
            ].join("\n"),
          },
          ctx,
        ),
        delay(5000).then(() => {
          throw new Error("apply_patch blocked on the FIFO");
        }),
      ]);

      const { changes, diffs } = Value.Parse(ChangesSchema, result.details);
      expect(changes).toEqual([
        { changed: true, kind: "delete", path: "pipe" },
        { changed: true, kind: "delete", lines: { added: 0, removed: 2 }, path: "plain.txt" },
      ]);
      expect(diffs.map((entry) => entry.index)).toEqual([1]);
      expect(diffs[0]?.diff).toContain("-1 one");
      await expect(readFile(path.join(cwd, "plain.txt"), "utf-8")).rejects.toThrow("ENOENT");
    },
  );

  it("keeps direct patch metadata and bounds oversized nested diagnostic strings", async () => {
    const cwd = await createTempDirectory();
    const big = Array.from({ length: 3000 }, (_, i) => `+${"x".repeat(30)} ${i}`);
    const names = Array.from({ length: 200 }, (_, i) => `dir/file-${i}.txt`);
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(registerFallbackCodexTools, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    const result = await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          ...["big-a.txt", "big-b.txt", "big-c.txt", "big-d.txt"].flatMap((name) => [
            `*** Add File: ${name}`,
            ...big,
          ]),
          ...names.flatMap((name) => [`*** Add File: ${name}`, "+one", "+two"]),
          "*** End Patch",
        ].join("\n"),
      },
      ctx,
    );

    const { changes, diffs } = Value.Parse(ChangesSchema, result.details);
    expect(changes).toHaveLength(204);
    expect(diffs).toHaveLength(204);
    // Each diff is capped on its own; there is no shared budget to exhaust.
    expect(Math.max(...diffs.map((entry) => entry.diff.length))).toBeLessThanOrEqual(
      MAX_DIFF_CHARS + 40,
    );
    expect(diffs[0]).toMatchObject({ index: 0 });
    expect(diffs[0]?.diff).toContain("[diff truncated for display]");

    // Diagnostic reduction preserves the change records and shortens large diffs.
    const nested = boundRuntimeToolResult({ content: [], details: result.details }, 0).details;
    const snapshot = Value.Parse(ChangesSchema, nested);
    expect(snapshot.changes).toEqual(changes);
    expect(snapshot.diffs).toHaveLength(diffs.length);
    expect(snapshot.diffs.some((entry) => entry.diff.endsWith("[value truncated]"))).toBe(true);
    expect(JSON.stringify(nested).length).toBeLessThanOrEqual(65_536);
    expect(Value.Parse(ChangesSchema, result.details).diffs).toEqual(diffs);
  });

  it("skips the display diff for a large rewrite but keeps it for a small edit", async () => {
    const cwd = await createTempDirectory();
    const lines = Array.from({ length: 6000 }, (_, i) => `line ${i} ${"x".repeat(30)}`);
    await writeFile(path.join(cwd, "big.txt"), `${lines.join("\n")}\n`, "utf-8");
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(registerFallbackCodexTools, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    const startedAt = performance.now();

    const rewrite = await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: big.txt",
          "@@",
          ...lines.map((line) => `-${line}`),
          ...lines.map((line) => `+${line.replace("line", "row")}`),
          "*** End Patch",
        ].join("\n"),
      },
      ctx,
    );

    // A full Myers diff of this rewrite takes seconds on the event loop; the patch's own line
    // counts bound the work up front so the change records metadata only.
    expect(performance.now() - startedAt).toBeLessThan(1500);
    const rewritten = Value.Parse(ChangesSchema, rewrite.details);
    expect(rewritten.changes).toEqual([
      { changed: true, kind: "update", lines: { added: 6000, removed: 6000 }, path: "big.txt" },
    ]);
    expect(rewritten.diffs).toEqual([]);
    await expect(readFile(path.join(cwd, "big.txt"), "utf-8")).resolves.toContain("row 5999 ");

    const edit = await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: big.txt",
          "@@",
          `-row 3000 ${"x".repeat(30)}`,
          `+row 3000 changed`,
          "*** End Patch",
        ].join("\n"),
      },
      ctx,
    );

    const edited = Value.Parse(ChangesSchema, edit.details);
    expect(edited.changes[0]).toMatchObject({ changed: true, lines: { added: 1, removed: 1 } });
    expect(edited.diffs[0]?.diff).toContain("+3001 row 3000 changed");

    // Fuzzy matching lets context lines replace file lines that differ only in whitespace, so a
    // context-only hunk can rewrite every line and must count toward the bound as well.
    await writeFile(
      path.join(cwd, "spaced.txt"),
      `${lines.map((line) => `${line}  `).join("\n")}\n`,
      "utf-8",
    );
    const contextStartedAt = performance.now();

    const contextOnly = await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: spaced.txt",
          "@@",
          ...lines.map((line) => ` ${line}`),
          "*** End Patch",
        ].join("\n"),
      },
      ctx,
    );

    expect(performance.now() - contextStartedAt).toBeLessThan(1500);
    const normalized = Value.Parse(ChangesSchema, contextOnly.details);
    // No plus or minus lines, yet the contents changed; `changed` records that directly.
    expect(normalized.changes).toEqual([
      { changed: true, kind: "update", lines: { added: 0, removed: 0 }, path: "spaced.txt" },
    ]);
    expect(normalized.diffs).toEqual([]);
    await expect(readFile(path.join(cwd, "spaced.txt"), "utf-8")).resolves.toBe(
      `${lines.join("\n")}\n`,
    );
  });

  it("counts deleted lines exactly beyond the diff read limit and per operation", async () => {
    const cwd = await createTempDirectory();
    const line = `${"y".repeat(120)}\n`;
    const bigLines = Math.ceil((1024 * 1024) / line.length) + 500;
    await writeFile(path.join(cwd, "huge.txt"), line.repeat(bigLines), "utf-8");
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(registerFallbackCodexTools, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    const result = await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Delete File: huge.txt",
          "*** Add File: a.txt",
          "+old",
          "*** Update File: a.txt",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      ctx,
    );

    const { changes, diffs } = Value.Parse(ChangesSchema, result.details);
    // Too large to diff, yet its line count is exact rather than a false zero.
    expect(changes[0]).toEqual({
      changed: true,
      kind: "delete",
      lines: { added: 0, removed: bigLines },
      path: "huge.txt",
    });
    // The same path touched twice keeps one diff per operation.
    expect(diffs.map((entry) => entry.index)).toEqual([1, 2]);
    expect(diffs[0]?.diff).toBe("+1 old");
    expect(diffs[1]?.diff).toContain("-1 old");
    expect(diffs[1]?.diff).toContain("+1 new");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "deletes unreadable files and leaves their counts unknown",
    async () => {
      const cwd = await createTempDirectory();
      const line = `${"y".repeat(120)}\n`;
      await writeFile(path.join(cwd, "huge.txt"), line.repeat(9000), {
        encoding: "utf-8",
        mode: 0,
      });
      await writeFile(path.join(cwd, "small.txt"), "one\ntwo\nthree\n", {
        encoding: "utf-8",
        mode: 0,
      });
      const model = createToolsModel("gpt-5.6-terra", true);
      const host = createExtensionHost(registerFallbackCodexTools, { model });
      const ctx = host.createContext({ cwd, model });
      await host.emitSessionStart(ctx);

      const result = await host.runTool(
        "apply_patch",
        {
          patch: [
            "*** Begin Patch",
            "*** Delete File: huge.txt",
            "*** Delete File: small.txt",
            "*** Add File: a.txt",
            "+new",
            "*** End Patch",
          ].join("\n"),
        },
        ctx,
      );

      // Display metadata is best-effort: an unreadable file is still deleted, and its count is
      // absent rather than a false zero.
      const { changes } = Value.Parse(ChangesSchema, result.details);
      expect(changes.slice(0, 2)).toEqual([
        { changed: true, kind: "delete", path: "huge.txt" },
        { changed: true, kind: "delete", path: "small.txt" },
      ]);
      await expect(readFile(path.join(cwd, "huge.txt"), "utf-8")).rejects.toThrow("ENOENT");
      await expect(readFile(path.join(cwd, "small.txt"), "utf-8")).rejects.toThrow("ENOENT");
    },
  );

  it("applies Codex move-only patches", async () => {
    const cwd = await createTempDirectory();
    await writeFile(path.join(cwd, "source.txt"), "unchanged\n", "utf-8");
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(registerFallbackCodexTools, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: source.txt",
          "*** Move to: moved.txt",
          "*** End Patch",
        ].join("\n"),
      },
      ctx,
    );

    await expect(readFile(path.join(cwd, "moved.txt"), "utf-8")).resolves.toBe("unchanged\n");
    await expect(readFile(path.join(cwd, "source.txt"), "utf-8")).rejects.toThrow("ENOENT");
  });

  it("anchors Codex end-of-file hunks and rejects trailing hunk lines", async () => {
    const cwd = await createTempDirectory();
    const file = path.join(cwd, "example.txt");
    await writeFile(file, "target\nmiddle\ntarget\n", "utf-8");
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(registerFallbackCodexTools, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: example.txt",
          "@@",
          "-target",
          "+last",
          "*** End of File",
          "*** End Patch",
        ].join("\n"),
      },
      ctx,
    );

    await expect(readFile(file, "utf-8")).resolves.toBe("target\nmiddle\nlast\n");
    await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: example.txt",
          "@@",
          "-target",
          "-middle",
          "-last",
          "*** End of File",
          "*** End Patch",
        ].join("\n"),
      },
      ctx,
    );
    await expect(readFile(file, "utf-8")).resolves.toBe("");

    await expect(
      host.runTool(
        "apply_patch",
        {
          patch: [
            "*** Begin Patch",
            "*** Update File: example.txt",
            "@@",
            "-last",
            "+invalid",
            "*** End of File",
            "+trailing",
            "*** End Patch",
          ].join("\n"),
        },
        ctx,
      ),
    ).rejects.toThrow("End-of-file marker must end the update");
  });

  it("does not start an already-aborted Codex patch", async () => {
    const cwd = await createTempDirectory();
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(registerFallbackCodexTools, { model });
    const ctx = host.createContext({ cwd, model });
    const controller = new AbortController();
    controller.abort();
    await host.emitSessionStart(ctx);

    await expect(
      host.runTool(
        "apply_patch",
        {
          patch: ["*** Begin Patch", "*** Add File: example.txt", "+hello", "*** End Patch"].join(
            "\n",
          ),
        },
        { ctx, signal: controller.signal },
      ),
    ).rejects.toThrow("Operation aborted");
    await expect(readFile(path.join(cwd, "example.txt"), "utf-8")).rejects.toThrow("ENOENT");
  });

  it("runs and continues Codex process sessions", async () => {
    const model = createToolsModel("gpt-5.6-luna", true);
    const host = createExtensionHost(registerFallbackCodexTools, { model });
    await host.emitSessionStart();

    const started = await host.runTool("exec_command", {
      cmd: "read value; printf 'got:%s' \"$value\"",
      yield_time_ms: 0,
    });

    const { sessionId } = Value.Parse(SessionDetailsSchema, started.details);

    if (sessionId === undefined) {
      throw new Error("exec_command did not report a session ID");
    }

    expect(textContent(started)).toContain(`Session ID: ${sessionId}`);

    const finished = await host.runTool("write_stdin", {
      chars: "hello\n",
      session_id: sessionId,
      yield_time_ms: 1000,
    });

    expect(textContent(finished)).toContain("got:hello");
    expect(textContent(finished)).toContain("Process exited with code 0");
    const finishedDetails = Value.Parse(SessionDetailsSchema, finished.details);
    expect(finishedDetails).toMatchObject({
      running: false,
      status: "exited",
    });
    expect(finishedDetails.sessionId).toBeUndefined();
  });

  it("measures each process poll independently", async () => {
    const host = createExtensionHost(() => {});
    const ctx = host.createContext();
    const manager = new ProcessManager();
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      const started = await manager.start({
        command: "read value",
        ctx,
        cwd: ctx.cwd,
        yieldMs: 0,
      });

      expect(started).toMatchObject({ durationMs: 0, status: "running" });

      if (started.status !== "running") {
        throw new Error("Expected a running process");
      }

      now = 60_000;

      const continued = await manager.continue({
        sessionId: started.sessionId,
        yieldMs: 0,
      });

      expect(continued).toMatchObject({ durationMs: 0, status: "running" });
    } finally {
      clock.mockRestore();
      await manager.dispose();
    }
  });

  it("rejects shells that reserve stdin for command transport", async () => {
    vi.spyOn(codingAgent, "getShellConfig").mockReturnValueOnce({
      args: ["-s"],
      commandTransport: "stdin",
      shell: process.execPath,
    });
    const model = createToolsModel("gpt-5.6-luna", true);
    const host = createExtensionHost(registerFallbackCodexTools, { model });
    await host.emitSessionStart();

    await expect(host.runTool("exec_command", { cmd: "printf unreachable" })).rejects.toThrow(
      "Shell stdin command transport is not supported",
    );
  });

  it.skipIf(process.platform === "win32")(
    "bounds completion when a detached descendant holds the output pipes",
    async () => {
      const cwd = await createTempDirectory();
      const marker = path.join(cwd, "descendant.txt");
      const model = createToolsModel("gpt-5.6-luna", true);
      const host = createExtensionHost(registerFallbackCodexTools, { model });
      await host.emitSessionStart();
      const startedAt = Date.now();
      const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 1200)`;

      const result = await host.runTool("exec_command", {
        cmd: `node -e ${JSON.stringify(`const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { detached: true, stdio: ["ignore", 1, 2] }); child.unref()`)}`,
        workdir: cwd,
      });

      expect(result.details).toMatchObject({ running: false });
      expect(Date.now() - startedAt).toBeLessThan(3000);
      await delay(500);
      await expect(readFile(marker, "utf-8")).resolves.toBe("alive");
    },
  );

  it("kills and forgets an aborted Codex process session", async () => {
    const model = createToolsModel("gpt-5.6-luna", true);
    const host = createExtensionHost(registerFallbackCodexTools, { model });
    await host.emitSessionStart();

    const started = await host.runTool("exec_command", {
      cmd: "read value",
      yield_time_ms: 0,
    });

    const { sessionId } = Value.Parse(SessionDetailsSchema, started.details);

    if (!sessionId) {
      throw new Error("Process session ID was not returned");
    }

    const controller = new AbortController();
    controller.abort();

    await expect(
      host.runTool(
        "write_stdin",
        { session_id: sessionId, yield_time_ms: 0 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Operation aborted");
    await expect(
      host.runTool("write_stdin", {
        session_id: sessionId,
        yield_time_ms: 0,
      }),
    ).rejects.toThrow(`Unknown process session: ${sessionId}`);
  });

  it.skipIf(process.platform === "win32")(
    "kills a process still inside its initial yield during shutdown",
    async () => {
      const cwd = await createTempDirectory();
      const marker = path.join(cwd, "leaked.txt");
      const model = createToolsModel("gpt-5.6-luna", true);
      const host = createExtensionHost(registerFallbackCodexTools, { model });
      const ctx = host.createContext({ cwd, model });
      await host.emitSessionStart(ctx);

      const running = host.runTool(
        "exec_command",
        {
          cmd: `node -e ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "leaked"), 1000)`)}`,
          yield_time_ms: 10_000,
        },
        ctx,
      );

      await delay(100);
      await host.emitSessionShutdown(ctx);
      await running;
      await delay(1100);

      await expect(readFile(marker, "utf-8")).rejects.toThrow("ENOENT");
    },
  );

  it("formats direct output from the preserved full stream", async () => {
    const model = createToolsModel("gpt-5.6-luna", true);
    const host = createExtensionHost(registerFallbackCodexTools, { model });
    await host.emitSessionStart();

    const result = await host.runTool("exec_command", {
      cmd: `node -e "for(let i=0;i<3000;i++) console.log('line')"`,
    });

    const details = Value.Parse(OutputDetailsSchema, result.details);

    // The returned text was rebuilt from the full output file, so the capture buffer's line
    // truncation no longer describes it and must not be reported.
    expect(details.truncation).toBeUndefined();
    expect(details.fullOutputPath).toBeTypeOf("string");
    expect(textContent(result)).not.toContain("Warning: truncated output");
    expect(textContent(result)).toContain("Full output:");
    const { fullOutputPath } = details;

    if (!fullOutputPath) {
      throw new Error("Full output path was not returned");
    }

    await expect(readFile(fullOutputPath, "utf-8")).resolves.toContain("line\nline\n");
    await rm(fullOutputPath);
  });
});
