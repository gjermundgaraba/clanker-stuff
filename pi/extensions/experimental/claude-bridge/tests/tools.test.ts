import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import { piToolName, resolveServedTools, sdkToolName } from "../tools.js";

const tool = (name: string): Tool => ({
  name,
  description: "",
  parameters: Type.Object({}),
});

describe("served tool names", () => {
  it("serves every pi tool under the custom-tools MCP prefix", () => {
    expect(sdkToolName("read")).toBe("mcp__custom-tools__read");
    expect(
      resolveServedTools([tool("read"), tool("ask_user")]).names
    ).toStrictEqual(new Set(["read", "ask_user"]));
  });

  it("maps a served name back to its pi tool", () => {
    const { names } = resolveServedTools([tool("WebFetch")]);

    expect(piToolName("mcp__custom-tools__WebFetch", names)).toBe("WebFetch");
  });

  // Claude Code answers an invented builtin, or a name in the wrong case, itself;
  // forwarding it would run a tool Claude Code never dispatched.
  it("does not resolve a name the bridge does not serve exactly", () => {
    const { names } = resolveServedTools([tool("read")]);

    expect(piToolName("Bash", names)).toBeUndefined();
    expect(piToolName("read", names)).toBeUndefined();
    expect(piToolName("mcp__other-server__read", names)).toBeUndefined();
    expect(piToolName("mcp__custom-tools__Read", names)).toBeUndefined();
  });
});

// Pi lists tool guidelines in the system prompt the bridge does not forward.
describe("served tool descriptions", () => {
  it("carry each tool's prompt guidelines", () => {
    const served = resolveServedTools(
      [{ ...tool("task_start"), description: "Start a job." }, tool("read")],
      new Map([["task_start", ["Do not poll task_list.", "  "]]])
    );

    expect(served.tools.map(({ description }) => description)).toStrictEqual([
      "Start a job.\n\nGuidelines:\n- Do not poll task_list.",
      "",
    ]);
  });
});
