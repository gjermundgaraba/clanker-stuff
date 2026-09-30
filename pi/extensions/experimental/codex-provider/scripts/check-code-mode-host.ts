import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ContentTools } from "@clanker-stuff/code-mode-tools";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureCodeModeHostBinary } from "../code-mode/binary.js";
import { HOST_RELEASE } from "../code-mode/host-assets.js";
import { CodeModeHostClient } from "../code-mode/host-client.js";
import { CodeModeRuntime, toNestedTool } from "../code-mode/tools.js";
import { createRealCodexSession } from "../tests/agent-session.js";
import { createToolsModel } from "../tests/fixtures.js";
import { createCodexDirectTools } from "../tools/direct.js";

// Exercise the native binary and the real public Pi pipeline, without inference.
const binary = await ensureCodeModeHostBinary(AbortSignal.timeout(120_000));

const client = new CodeModeHostClient(binary);

const runtime = new CodeModeRuntime({ createClient: async () => client });

const direct = createCodexDirectTools();

const rootDir = await realpath(await mkdtemp(path.join(tmpdir(), "codex-host-check-")));

const sampleUsage = {
  input: 2,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let slowEntered = Promise.withResolvers<void>();

let slowSettled = false;

let slowCleanupMs = 25;

let session: Awaited<ReturnType<typeof createRealCodexSession>> | undefined;

try {
  session = await createRealCodexSession({
    rootDir,
    model: createToolsModel("gpt-6-astra", true),
    sessionManager: SessionManager.inMemory(rootDir),
    extensionFactories: [
      (pi) => {
        for (const definition of direct.definitions) pi.registerTool(definition);
        pi.registerTool(runtime.createExecTool());
        const content = new ContentTools(pi);
        content.registerTool({
          name: "content_probe",
          label: "Probe",
          description: "Test structured content and accounting",
          parameters: Type.Object({ fail: Type.Optional(Type.Boolean()) }),
          execute: async (_id, params) => ({
            content: [
              { type: "text", text: params.fail ? "sampled failure" : '{"verified":true}' },
            ],
            details: undefined,
            usage: sampleUsage,
            ...(params.fail ? { isError: true } : {}),
          }),
        });
        pi.registerTool({
          name: "slow_probe",
          label: "Slow",
          description: "Test cancellation settlement",
          parameters: Type.Object({}),
          execute: async (_id, _args, signal) => {
            assert(signal);
            slowEntered.resolve();
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            await delay(slowCleanupMs);
            slowSettled = true;

            return {
              content: [{ type: "text", text: "cancelled" }],
              details: undefined,
              isError: true,
              usage: sampleUsage,
            };
          },
        });
        pi.on("session_start", () => {
          content.setEnabled();
          pi.setActiveTools([
            ...direct.definitions.map((tool) => tool.name),
            "content_probe",
            "slow_probe",
            "exec",
          ]);
        });
        pi.on("session_shutdown", async () => {
          await runtime.shutdown();
          await direct.dispose();
        });
      },
    ],
  });
  session.agent.state.messages = [
    ...session.agent.state.messages,
    fauxAssistantMessage(
      fauxToolCall("exec", { code: "host protocol checks" }, { id: "host-check" }),
      { stopReason: "toolUse" },
    ),
  ];
  const ctx = session.extensionRunner.createToolContext("host-check", undefined);

  const tools = ctx.tools.map((tool) =>
    toNestedTool(tool, session?.getToolDefinition(tool.name)?.namespace?.name),
  );

  const execute = (source: string, signal = AbortSignal.timeout(15_000)) =>
    client.execute(source, { extensionContext: ctx }, signal, tools);

  const text = (response: Awaited<ReturnType<typeof execute>>) =>
    response.contentItems.map((item) => item.text).filter((value) => value !== undefined);

  const successful = (response: Awaited<ReturnType<typeof execute>>) => {
    assert.equal(response.kind, "result");
    assert(
      !("errorText" in response) || response.errorText === undefined,
      JSON.stringify(response),
    );
  };

  const simple = await execute("text(6 * 7)");
  successful(simple);
  assert.deepEqual(text(simple), ["42"]);

  const undefinedStore = await execute(
    'store("undefined-check", null); try { store("undefined-check", undefined); } catch (error) { text(String(error)); } text(load("undefined-check"));',
  );

  successful(undefinedStore);
  assert.deepEqual(text(undefinedStore), [
    'Unable to store "undefined-check". Only plain serializable objects can be stored.',
    "null",
  ]);
  assert.deepEqual(text(await execute('text(load("undefined-check"));')), ["null"]);

  const nested = await execute(
    'const result = await tools.exec_command({cmd:"pwd",max_output_tokens:100}); text(result.output.trim()); text(ALL_TOOLS.map(tool => tool.name));',
  );

  successful(nested);
  assert(text(nested).includes(rootDir));
  assert(text(nested).some((value) => value.includes("exec_command")));

  const probe = await execute(
    "const result = await tools.content_probe({}); text(JSON.parse(result.content[0].text));",
  );

  successful(probe);
  assert(text(probe).some((value) => value.includes('"verified":true')));
  assert(
    probe.traces?.some(
      (trace) => trace.id.startsWith("host-check/") && trace.name === "content_probe",
    ),
  );

  // Yields are native host operations, not a second model-facing call.
  const yielded = await execute(
    'text("before"); yield_control(); await new Promise(resolve => setTimeout(resolve, 25)); text("after");',
  );

  successful(yielded);
  assert.deepEqual(text(yielded), ["before", "after"]);
  const notification = await execute('notify("live"); yield_control(); text("done");');
  successful(notification);
  assert(text(notification).includes("live"));
  assert(text(notification).includes("done"));

  const first = execute(
    'text("first-start"); yield_control(); await new Promise(resolve => setTimeout(resolve, 40)); text("first-end");',
  );

  const second = execute('text("second-start"); yield_control(); text("second-end");');
  const interleaved = await Promise.all([first, second]);
  interleaved.forEach(successful);
  assert.deepEqual(text(interleaved[0]), ["first-start", "first-end"]);
  assert.deepEqual(text(interleaved[1]), ["second-start", "second-end"]);

  const bounded = await execute(
    '// @exec: {"max_output_tokens":2}\ntext("abcdefghijk"); yield_control(); text("more output");',
  );

  successful(bounded);
  assert.deepEqual(text(bounded), ["abcdefgh\n[Output truncated]"]);

  const failed = await execute('text("before failure"); await tools.content_probe({fail:true});');
  assert(failed.kind === "result" && failed.errorText?.includes("sampled failure"));
  const invalid = await execute("await tools.exec_command({});");
  assert(
    invalid.kind === "result" && invalid.errorText?.includes("Validation failed"),
    JSON.stringify(invalid),
  );
  const unavailable = await execute('await tools.exec({code:"text(1)"});');
  assert(unavailable.kind === "result" && unavailable.errorText);

  const abort = new AbortController();
  const cancelling = execute("await tools.slow_probe({});", abort.signal);
  const cancelled = assert.rejects(cancelling, { name: "AbortError" });
  await slowEntered.promise;
  abort.abort();
  await cancelled;
  assert.equal(slowSettled, true, "exec must settle delegate cleanup before rejecting");
  successful(await execute('text("usable after cancellation");'));

  // A replacement host may reuse cell/delegate IDs while old Pi calls still settle.
  slowEntered = Promise.withResolvers<void>();
  slowSettled = false;
  slowCleanupMs = 500;
  const stopping = execute("await tools.slow_probe({});");

  const stopped = stopping.then(
    (response) => assert.equal(response.kind, "terminated", JSON.stringify(response)),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /Code-mode host/u);
    },
  );

  await slowEntered.promise;
  await client.shutdown();

  const replacement = execute(
    "const value = await tools.content_probe({}); text(value.content[0].text);",
  );

  const [replacementResult] = await Promise.all([replacement, stopped]);
  successful(replacementResult);
  assert(text(replacementResult).includes('{"verified":true}'));
  assert.equal(slowSettled, true);

  // Both successful and failed nested sampling usage belongs to the actual outer result.
  for (const fail of [false, true]) {
    const outerId = `accounting-${fail}`;
    let request = 0;
    session.agent.streamFunction = (model) => {
      const firstRequest = request++ === 0;

      const message = {
        ...fauxAssistantMessage("done"),
        api: model.api,
        model: model.id,
        provider: model.provider,
        ...(firstRequest
          ? {
              content: [
                {
                  type: "toolCall" as const,
                  id: outerId,
                  name: "exec",
                  arguments: { code: `await tools.content_probe({fail:${fail}});` },
                },
              ],
              stopReason: "toolUse" as const,
            }
          : {}),
      };

      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: firstRequest ? "toolUse" : "stop", message });

      return stream;
    };

    await session.prompt("Run the accounting check");
    const messages: typeof session.messages = session.messages;

    const result = messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === outerId,
    );

    assert(result?.role === "toolResult");
    assert.deepEqual(result.usage, sampleUsage);
    assert.equal(result.isError, fail);
    assert.partialDeepStrictEqual(result.nestedCalls, {
      complete: true,
      calls: [{ id: `${outerId}/1`, name: "content_probe", status: fail ? "error" : "ok" }],
    });
  }

  console.log(
    JSON.stringify(
      {
        release: HOST_RELEASE,
        binary,
        platform: `${process.platform}-${process.arch}`,
        verified: [
          "execution",
          "store",
          "Pi nested pipeline",
          "internal yields",
          "interleaved execution",
          "output bounds",
          "errors",
          "cancellation settlement",
          "persisted accounting",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await runtime.shutdown();
  await direct.dispose();
  session?.dispose();
  await rm(rootDir, { force: true, recursive: true });
}
