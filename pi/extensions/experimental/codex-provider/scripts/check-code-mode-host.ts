import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ensureCodeModeHostBinary } from "../code-mode/binary.js";
import { HOST_RELEASE } from "../code-mode/host-assets.js";
import { CodeModeHostClient } from "../code-mode/host-client.js";
import { toNestedTool } from "../code-mode/tools.js";
import type { ToolExecutionContext } from "../code-mode/types.js";
import { createRealCodexSession } from "../tests/agent-session.js";
import { createCodexDirectTools } from "../tools/direct.js";

// Exercise the downloaded binary and real adapter without inference or installed credentials.
const binary = await ensureCodeModeHostBinary(AbortSignal.timeout(120_000));
const client = new CodeModeHostClient(binary);
const direct = createCodexDirectTools();
const tools = direct.nestedDefinitions.map((definition) => toNestedTool({ definition }));
const rootDir = await realpath(await mkdtemp(path.join(tmpdir(), "codex-host-check-")));
const context = Promise.withResolvers<ExtensionContext>();
let session: Awaited<ReturnType<typeof createRealCodexSession>> | undefined;
try {
  session = await createRealCodexSession({
    extensionFactories: [
      (pi) => {
        pi.on("session_start", (_event, ctx) => context.resolve(ctx));
      },
    ],
    rootDir,
    sessionManager: SessionManager.inMemory(rootDir),
  });
  const ctx = { extensionContext: await context.promise };
  const execute = (source: string) =>
    client.execute(source, ctx, AbortSignal.timeout(15_000), tools);

  const simple = await execute("text(6 * 7)");
  assert.equal(simple.kind, "result");
  assert("errorText" in simple && simple.errorText === undefined);
  assert(simple.contentItems.some((item) => item.text === "42"));

  const nested = await execute(
    'const result = await tools.exec_command({cmd:"pwd",max_output_tokens:100}); text(result.output.trim()); text(ALL_TOOLS.map(tool => tool.name));',
  );
  assert.equal(nested.kind, "result");
  assert(nested.contentItems.some((item) => item.text === rootDir));
  assert(nested.contentItems.some((item) => item.text?.includes("exec_command")));

  const failed = await execute('throw new Error("HOST_CHECK_ERROR")');
  assert(failed.kind === "result" && failed.errorText?.includes("HOST_CHECK_ERROR"));

  const yielded = await execute(
    '// @exec: {"yield_time_ms":0}\nawait new Promise(resolve => setTimeout(resolve, 100)); text("AFTER_WAIT");',
  );
  assert.equal(yielded.kind, "yielded");
  const waited = await client.wait(yielded.cellId, 1_000, ctx, AbortSignal.timeout(15_000));
  assert.equal(waited.kind, "result");
  assert(waited.contentItems.some((item) => item.text === "AFTER_WAIT"));

  const running = await execute(
    '// @exec: {"yield_time_ms":0}\nawait new Promise(resolve => setTimeout(resolve, 10000));',
  );
  assert.equal(running.kind, "yielded");
  const terminated = await client.terminate(running.cellId, ctx, AbortSignal.timeout(15_000));
  assert.equal(terminated.kind, "terminated");

  // Internal termination after exec cancellation must not subscribe the cancelled card again.
  const admitted = Promise.withResolvers<void>();
  const abortExec = new AbortController();
  const abortDeadline = AbortSignal.timeout(15_000);
  abortDeadline.addEventListener("abort", () => admitted.reject(abortDeadline.reason), {
    once: true,
  });
  let execUpdates = 0;
  const cancelledExec = client.execute(
    "await new Promise(() => {});",
    {
      ...ctx,
      onUpdate: () => {
        execUpdates++;
        admitted.resolve();
      },
    },
    AbortSignal.any([abortExec.signal, abortDeadline]),
    tools,
  );
  void cancelledExec.catch(() => {});
  await admitted.promise;
  abortExec.abort();
  await assert.rejects(cancelledExec, { name: "AbortError" });
  await execute('text("AFTER_EXEC_CANCEL")');
  assert.equal(execUpdates, 1);

  // Keep a nested call open so updates can be emitted after the host rejects/cancels a wait.
  for (const cancelWait of [false, true]) {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<NonNullable<ToolExecutionContext["onUpdate"]>>();
    const signal = AbortSignal.timeout(15_000);
    signal.addEventListener("abort", () => started.reject(signal.reason), { once: true });
    const counts = { exec: 0, a: 0, b: 0 };
    const watching = (name: keyof typeof counts): ToolExecutionContext => ({
      ...ctx,
      onUpdate: () => {
        counts[name]++;
      },
    });
    const probe = toNestedTool({
      definition: {
        name: "observer_probe",
        label: "Observer probe",
        description: "Hold a call for host checks",
        parameters: Type.Object({}),
        execute: async (_id, _args, _signal, onUpdate) => {
          assert(onUpdate);
          started.resolve(onUpdate);
          await release.promise;
          return { content: [], details: undefined };
        },
      },
    });
    try {
      const cell = await client.execute(
        '// @exec: {"yield_time_ms":0}\nawait tools.observer_probe({}); text("PROBE_DONE");',
        watching("exec"),
        signal,
        [...tools, probe],
      );
      assert.equal(cell.kind, "yielded");
      const emit = await started.promise;
      const controller = new AbortController();
      const first = client.wait(
        cell.cellId,
        10_000,
        watching("a"),
        AbortSignal.any([signal, controller.signal]),
      );
      void first.catch(() => {});
      // There is no wait-accepted event; allow the host to install its first observer.
      await delay(50, undefined, { signal });
      await assert.rejects(
        client.wait(cell.cellId, 10_000, watching("b"), signal),
        /already has an active observer/u,
      );
      const before = { ...counts };
      const progress = {
        content: [{ type: "text" as const, text: "progress" }],
        details: undefined,
      };
      emit(progress);
      assert.deepEqual(counts, { ...before, a: before.a + 1 });
      if (cancelWait) {
        controller.abort();
        await assert.rejects(first, { name: "AbortError" });
        const cancelled = { ...counts };
        emit(progress);
        assert.deepEqual(counts, cancelled);
        // Cancellation releases the native observer asynchronously.
        await delay(50, undefined, { signal });
      }
      release.resolve();
      const completed = cancelWait
        ? await client.wait(cell.cellId, 1000, ctx, signal)
        : await first;
      assert.equal(completed.kind, "result");
      assert(completed.contentItems.some((item) => item.text === "PROBE_DONE"));
      const settled = { ...counts };
      emit(progress);
      assert.deepEqual(counts, settled);
    } finally {
      release.resolve();
    }
  }

  console.log(
    `PASS ${HOST_RELEASE} (${process.platform}-${process.arch}): execution, nested tools, errors, wait, termination, observer rejection/cancellation\n${binary}`,
  );
} finally {
  await client.shutdown();
  await direct.dispose();
  session?.dispose();
  await rm(rootDir, { recursive: true, force: true });
}
