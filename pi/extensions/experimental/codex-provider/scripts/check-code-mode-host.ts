import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ensureCodeModeHostBinary } from "../code-mode/binary.js";
import { HOST_RELEASE } from "../code-mode/host-assets.js";
import { CodeModeHostClient } from "../code-mode/host-client.js";
import { toNestedTool } from "../code-mode/tools.js";
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

  console.log(
    `PASS ${HOST_RELEASE} (${process.platform}-${process.arch}): execution, nested tools, errors, wait, termination\n${binary}`,
  );
} finally {
  await client.shutdown();
  await direct.dispose();
  session?.dispose();
  await rm(rootDir, { recursive: true, force: true });
}
