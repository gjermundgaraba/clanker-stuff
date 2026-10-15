// The bridge inside a real AgentSession, with a scripted query in place of Claude Code:
// what pi does with the turns the bridge hands it. No Claude Code process, so it runs
// without CLAUDE_BRIDGE_LIVE.

import { rm } from "node:fs/promises";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { patchEnv } from "../../../../tests/helpers/env.js";
import { createTempDir } from "../../../../tests/helpers/fs.js";
import { createClaudeBridge } from "../index.js";
import {
  blockStop,
  init,
  inputJsonDelta,
  messageDelta,
  messageStart,
  messageStop,
  successResult,
  toolUseStart,
} from "./fixtures/sdk.js";
import { fakeQueryFunction } from "./helpers.js";

let configDir: string;

let restoreEnv: () => void;

beforeEach(async () => {
  configDir = await createTempDir("claude-bridge-config-");
  restoreEnv = patchEnv({ CLAUDE_CONFIG_DIR: configDir });
});

afterEach(async () => {
  restoreEnv();
  await rm(configDir, { recursive: true, force: true });
});

// Claude ran out of output tokens inside a write: its arguments are whatever JSON
// survived. pi does not run a call from a truncated response: it answers the call with
// an error asking for it again, and continues. The bridge must not present the call as
// an ordinary one, and Claude Code must hear pi's answer, not go on from the cut alone.
it("does not run a tool call Claude was cut off in the middle of", async () => {
  const fake = fakeQueryFunction();
  const written: unknown[] = [];

  const write = defineTool({
    name: "write",
    label: "write",
    description: "Write a file",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: (_id, params) => {
      written.push(params);

      return Promise.resolve({ content: [{ type: "text", text: "written" }], details: {} });
    },
  });

  const h = await createAgentSessionHarness({
    extensionFactories: [createClaudeBridge(fake.run)],
    tools: [write],
  });

  try {
    const bridgeModel = h.session.modelRuntime.getModel("claude-bridge", "claude-haiku-5-5");

    if (bridgeModel === undefined) throw new Error("claude-bridge model not registered");

    await h.session.setModel(bridgeModel);

    const run = h.prompt("Write the report to important.txt.");

    const started = (index: number) =>
      vi.waitFor(() => {
        const query = fake.queries[index];

        if (query === undefined) throw new Error(`query ${index} has not started`);

        return query;
      });

    const query = await started(0);

    query.push(init("cc-1"));
    query.push(messageStart("msg_1"));
    query.push(toolUseStart(0, "mcp__custom-tools__write", "toolu_1"));
    query.push(inputJsonDelta(0, '{"path":"important.txt","content":"only the first part'));
    query.push(blockStop(0));
    query.push(messageDelta("max_tokens"));
    query.push(messageStop());

    const next = await started(1);

    expect(query.closed).toBe(true);
    // pi's answer to the cut-off call reaches Claude Code in a session rebuilt from pi.
    expect(next.params.options.resume).toEqual(expect.any(String));
    expect(next.params.options.resume).not.toBe("cc-1");

    next.push(init("cc-2"));
    next.push(successResult("I will write it again in parts."));
    next.end();
    await run;

    const conversation = h.session.messages.filter((message) => message.role !== "system");

    expect(written).toEqual([]);
    expect(conversation.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(conversation[2]).toMatchObject({ isError: true });
  } finally {
    h.cleanup();
  }
});
