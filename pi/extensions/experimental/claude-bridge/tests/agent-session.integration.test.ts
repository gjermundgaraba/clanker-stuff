// The bridge inside a real AgentSession, with a scripted query in place of Claude Code:
// what pi does with the turns the bridge hands it. No Claude Code process, so it runs
// without CLAUDE_BRIDGE_LIVE.

import { rm } from "node:fs/promises";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { patchEnv } from "../../../../tests/helpers/env.js";
import { createTempDir } from "../../../../tests/helpers/fs.js";
import { createClaudeBridge } from "../index.js";
import {
  assistantMessage,
  blockStop,
  init,
  inputJsonDelta,
  messageDelta,
  messageStart,
  messageStop,
  successResult,
  textBlock,
  toolUseStart,
} from "./fixtures/sdk.js";
import { fakeQueryFunction } from "./helpers.js";

describe("the bridge inside an AgentSession", () => {
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

  // pi writes to the messages a turn hands it (it records the requested thinking level on the
  // output) after the bridge has recorded them, so the conversation must not hold pi's objects.
  it("answers a turn that calls a tool, in one query", async () => {
    const fake = fakeQueryFunction();

    const read = defineTool({
      name: "read",
      label: "read",
      description: "Read a file",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "contents" }],
        details: {},
      }),
    });

    const h = await createAgentSessionHarness({
      extensionFactories: [createClaudeBridge(fake.run)],
      tools: [read],
    });

    try {
      const bridgeModel = h.session.modelRuntime.getModel(
        "claude-bridge",
        "claude-haiku-5-5"
      );

      if (bridgeModel === undefined) {
        throw new Error("claude-bridge model not registered");
      }

      await h.session.setModel(bridgeModel);

      const run = h.prompt("Read the file.");

      const query = await vi.waitFor(() => {
        const [started] = fake.queries;

        if (started === undefined) {
          throw new Error("the query has not started");
        }

        return started;
      });

      query.push(init("cc-1"));
      query.push(
        assistantMessage("msg_1", [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "mcp__custom-tools__read",
            input: {},
          },
        ])
      );

      await vi.waitFor(() => {
        expect(h.session.messages.at(-1)?.role).toBe("toolResult");
      });

      query.push(assistantMessage("msg_2", [textBlock("It says contents.")]));
      query.push(successResult("It says contents."));
      query.end();
      await run;

      const conversation = h.session.messages.filter(
        (message) => message.role !== "system"
      );

      expect(conversation).toMatchObject([
        { role: "user" },
        { role: "assistant", stopReason: "toolUse" },
        { role: "toolResult", isError: false },
        { role: "assistant", stopReason: "stop" },
      ]);
      expect(fake.queries).toHaveLength(1);
    } finally {
      h.cleanup();
    }
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
      execute: async (_id, params) => {
        written.push(params);

        return {
          content: [{ type: "text", text: "written" }],
          details: {},
        };
      },
    });

    const h = await createAgentSessionHarness({
      extensionFactories: [createClaudeBridge(fake.run)],
      tools: [write],
    });

    try {
      const bridgeModel = h.session.modelRuntime.getModel(
        "claude-bridge",
        "claude-haiku-5-5"
      );

      if (bridgeModel === undefined) {
        throw new Error("claude-bridge model not registered");
      }

      await h.session.setModel(bridgeModel);

      const run = h.prompt("Write the report to important.txt.");

      const started = async (index: number) =>
        await vi.waitFor(() => {
          const query = fake.queries[index];

          if (query === undefined) {
            throw new Error(`query ${index} has not started`);
          }

          return query;
        });

      const query = await started(0);

      query.push(init("cc-1"));
      query.push(messageStart("msg_1"));
      query.push(toolUseStart(0, "mcp__custom-tools__write", "toolu_1"));
      query.push(
        inputJsonDelta(
          0,
          '{"path":"important.txt","content":"only the first part'
        )
      );
      query.push(blockStop(0));
      query.push(messageDelta("max_tokens"));
      query.push(messageStop());

      const next = await started(1);

      expect(query.closed).toBe(true);
      // pi's answer to the cut-off call reaches Claude Code in a session rebuilt from pi.
      expect(next.params.options.resume).toStrictEqual(expect.any(String));
      expect(next.params.options.resume).not.toBe("cc-1");

      next.push(init("cc-2"));
      next.push(successResult("I will write it again in parts."));
      next.end();
      await run;

      const conversation = h.session.messages.filter(
        (message) => message.role !== "system"
      );

      expect(written).toStrictEqual([]);
      expect(conversation.map((message) => message.role)).toStrictEqual([
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
});
