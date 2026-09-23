import assert from "node:assert/strict";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createCodexModelCatalog } from "../model-catalog.js";
import { registerCodexTools } from "../tools/register.js";
import { createToolsModel } from "../tests/fixtures.js";
import { collectContributions, ContributedTools } from "@clanker-stuff/code-mode-tools";
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
import { withExecutionSettings } from "../tools/execution-context.js";

// Exercise the downloaded binary and real adapter without inference or installed credentials.
const binary = await ensureCodeModeHostBinary(AbortSignal.timeout(120_000));

const client = new CodeModeHostClient(binary);

const direct = createCodexDirectTools();

const tools = direct.nestedDefinitions.map((definition) => toNestedTool({ definition }));

const rootDir = await realpath(await mkdtemp(path.join(tmpdir(), "codex-host-check-")));

const context = Promise.withResolvers<ExtensionContext>();

const sampleUsage = {
  input: 2,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let session: Awaited<ReturnType<typeof createRealCodexSession>> | undefined;

try {
  session = await createRealCodexSession({
    extensionFactories: [
      (pi) => {
        const accounting = new Map<string, { usage: typeof sampleUsage }>();

        const source = new ContributedTools(pi, (id) => {
          const entry = accounting.get(id);
          accounting.delete(id);

          return entry;
        });

        source.registerTool({
          name: "contributed_probe",
          label: "Probe",
          description: "Check contributed content envelopes",
          parameters: Type.Object({ fail: Type.Optional(Type.Boolean()) }),
          execute: async (id, params) => {
            accounting.set(id, { usage: sampleUsage });

            if (params.fail) throw new Error("sampled failure");

            return { content: [{ type: "text", text: '{"verified":true}' }], details: undefined };
          },
        });
        pi.on("session_start", (_event, ctx) => {
          source.setEnabled(["contributed_probe"]);

          for (const source of collectContributions(pi))
            tools.push(...source.tools.map((tool) => toNestedTool(tool)));
          context.resolve(ctx);
        });
        registerCodexTools(pi, createCodexModelCatalog(), { evaluationToolMode: "code_mode_only" });
      },
    ],
    rootDir,
    model: createToolsModel("gpt-6-astra", true),
    sessionManager: SessionManager.inMemory(rootDir),
  });
  const ctx = { extensionContext: await context.promise };

  const execute = (source: string) =>
    client.execute(source, ctx, AbortSignal.timeout(15_000), tools);

  const simple = await execute("text(6 * 7)");
  assert.equal(simple.kind, "result");
  assert(!("errorText" in simple) || simple.errorText === undefined, JSON.stringify(simple));
  assert(simple.contentItems.some((item) => item.text === "42"));

  // 0.155.0 fixes undefined handling before V8 JSON serialization. A rejected
  // store must preserve the previous value, including across execution cells.
  const undefinedStore = await execute(
    'store("undefined-check", null); try { store("undefined-check", undefined); } catch (error) { text(String(error)); } text(load("undefined-check"));',
  );

  assert.equal(undefinedStore.kind, "result");
  assert(!("errorText" in undefinedStore) || undefinedStore.errorText === undefined);
  assert.deepEqual(
    undefinedStore.contentItems.map((item) => item.text),
    ['Unable to store "undefined-check". Only plain serializable objects can be stored.', "null"],
  );
  const stored = await execute('text(load("undefined-check"));');
  assert.equal(stored.kind, "result");
  assert.deepEqual(
    stored.contentItems.map((item) => item.text),
    ["null"],
  );

  const nested = await execute(
    'const result = await tools.exec_command({cmd:"pwd",max_output_tokens:100}); text(result.output.trim()); text(ALL_TOOLS.map(tool => tool.name));',
  );

  assert.equal(nested.kind, "result");
  assert(nested.contentItems.some((item) => item.text === rootDir));
  assert(nested.contentItems.some((item) => item.text?.includes("exec_command")));

  const probe = await execute(
    "const result = await tools.contributed_probe({}); text(JSON.parse(result.content[0].text));",
  );

  assert.equal(probe.kind, "result");
  assert(!("errorText" in probe) || probe.errorText === undefined);
  assert(probe.contentItems.some((item) => item.text?.includes('"verified":true')));

  // 0.156.1 owns delegates per execution. Interleaved cells must retain their
  // original tools/settings across yields, even when wait supplies another model.
  const probes = ["gpt-6-sol", "gpt-6-luna"].map((id) => ({
    id,
    release: Promise.withResolvers<void>(),
  }));

  const cells = [];

  try {
    for (const { id, release } of probes) {
      const entered = Promise.withResolvers<void>();
      const signal = AbortSignal.timeout(15_000);
      signal.addEventListener("abort", () => entered.reject(signal.reason), { once: true });

      const cellProbe = toNestedTool({
        definition: {
          name: "cell_probe",
          label: "Cell probe",
          description: "Report the originating cell's settings",
          parameters: Type.Object({}),
          execute: async (_callId, _args, _signal, _onUpdate, executionContext) => ({
            content: [{ type: "text", text: `${id}:${executionContext.model?.id}` }],
            details: undefined,
          }),
        },
      });

      const gate = toNestedTool({
        definition: {
          name: "cell_gate",
          label: "Cell gate",
          description: "Hold the cell across another execution",
          parameters: Type.Object({}),
          execute: async () => {
            entered.resolve();
            await release.promise;

            return { content: [], details: undefined };
          },
        },
      });

      const cell = await client.execute(
        '// @exec: {"yield_time_ms":0}\nawait tools.cell_gate({}); text(await tools.cell_probe({}));',
        {
          extensionContext: withExecutionSettings(ctx.extensionContext, {
            model: createToolsModel(id, true),
            thinkingLevel: "medium",
          }),
        },
        signal,
        [gate, cellProbe],
      );

      assert.equal(cell.kind, "yielded");
      await entered.promise;
      cells.push({ id, cell, release, signal });
    }

    for (const { id, cell, release, signal } of cells.toReversed()) {
      release.resolve();
      const result = await client.wait(cell.cellId, 1000, ctx, signal);
      assert.equal(result.kind, "result");
      assert(!("errorText" in result) || result.errorText === undefined);
      assert(result.contentItems.some((item) => item.text?.includes(`${id}:${id}`)));
    }
  } finally {
    for (const { release } of probes) release.resolve();
  }

  const slowStarted = Promise.withResolvers<void>();

  const slow = toNestedTool({
    definition: {
      name: "slow_cleanup",
      label: "Slow cleanup",
      description: "Slow cancellation cleanup",
      parameters: Type.Object({}),
      execute: async (_id, _args, signal) => {
        slowStarted.resolve();
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        await delay(1200);
        throw new Error("SLOW_CLEANUP_DONE");
      },
    },
  });

  const slowCell = await client.execute(
    '// @exec: {"yield_time_ms":0}\nawait new Promise(resolve => setTimeout(resolve, 50)); notify("BEFORE_SLOW_CLEANUP"); await tools.slow_cleanup({});',
    ctx,
    AbortSignal.timeout(15_000),
    [slow],
  );

  assert.equal(slowCell.kind, "yielded");
  assert.equal(slowCell.contentItems.length, 0);
  await slowStarted.promise;
  const slowTerminal = await client.terminate(slowCell.cellId, ctx, AbortSignal.timeout(15_000));
  assert(slowTerminal.contentItems.some((item) => item.text === "BEFORE_SLOW_CLEANUP"));
  assert(
    slowTerminal.traces?.some(
      (trace) => trace.name === "slow_cleanup" && trace.error === "SLOW_CLEANUP_DONE",
    ),
  );

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

  // Full registry -> native host -> executor -> tool_result hook -> Pi history path.
  let request = 0;
  session.agent.streamFunction = (model) => {
    const step = request++;
    const toolCall = step % 2 === 0;
    const stream = createAssistantMessageEventStream();

    const message = {
      ...fauxAssistantMessage("done"),
      api: model.api,
      model: model.id,
      provider: model.provider,
      ...(toolCall
        ? {
            content: [
              {
                type: "toolCall" as const,
                id: `accounting-${step}`,
                name: "exec",
                arguments: { code: `await tools.contributed_probe({fail:${step === 2}});` },
              },
            ],
            stopReason: "toolUse" as const,
          }
        : {}),
    };

    stream.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message });

    return stream;
  };

  await session.prompt("Sample successfully");
  await session.prompt("Sample and fail");

  const results = session.messages.filter(
    (message) => message.role === "toolResult" && message.toolName === "exec",
  );

  assert.equal(results.length, 2);

  for (const result of results) {
    assert(result.role === "toolResult");
    assert.deepEqual(result.usage, sampleUsage);
  }

  console.log(
    `PASS ${HOST_RELEASE} (${process.platform}-${process.arch}): execution, nested tools, errors, wait, termination, interleaved cell settings, observer rejection/cancellation, persisted accounting\n${binary}`,
  );
} finally {
  await client.shutdown();
  await direct.dispose();
  await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session?.dispose();
  await rm(rootDir, { recursive: true, force: true });
}
