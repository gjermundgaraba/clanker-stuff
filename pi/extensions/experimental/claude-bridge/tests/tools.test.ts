import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import {
  piToolName,
  resolveServedTools,
  sdkToolName,
  withArgumentDefaults,
} from "../tools.js";

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

  it("does not resolve a name the bridge does not serve exactly", () => {
    const { names } = resolveServedTools([tool("read")]);

    expect(piToolName("Bash", names)).toBeUndefined();
    expect(piToolName("read", names)).toBeUndefined();
    expect(piToolName("mcp__other-server__read", names)).toBeUndefined();
    expect(piToolName("mcp__custom-tools__Read", names)).toBeUndefined();
  });
});

const bash = (parameters: Tool["parameters"]): Tool => ({
  name: "bash",
  description: "",
  parameters,
});

describe("argument defaults", () => {
  it("give a bash call Claude Code's 120 second timeout when it sets none", () => {
    const served = resolveServedTools([
      bash(
        Type.Object({
          command: Type.String(),
          timeout: Type.Optional(Type.Number()),
        })
      ),
    ]);

    expect(
      withArgumentDefaults(served, "bash", { command: "ls" })
    ).toStrictEqual({ timeout: 120, command: "ls" });
    expect(
      withArgumentDefaults(served, "bash", { command: "make", timeout: 900 })
    ).toStrictEqual({ timeout: 900, command: "make" });
  });

  it("are what Claude reads in the served schema, in place of pi's no-default text", () => {
    const served = resolveServedTools([
      bash(
        Type.Object({
          command: Type.String({ description: "Command to run" }),
          timeout: Type.Optional(
            Type.Number({ description: "Timeout in seconds (no default)" })
          ),
        })
      ),
    ]);

    expect(served.tools[0]?.inputSchema["properties"]).toStrictEqual({
      command: { type: "string", description: "Command to run" },
      timeout: {
        type: "number",
        description:
          "Timeout in seconds. A call that sets none stops after 120 seconds.",
      },
    });
  });

  it("add nothing a tool's schema does not take", () => {
    const served = resolveServedTools([
      bash(Type.Object({ command: Type.String() })),
      { ...tool("read"), parameters: Type.Object({ timeout: Type.Number() }) },
    ]);

    expect(
      withArgumentDefaults(served, "bash", { command: "ls" })
    ).toStrictEqual({ command: "ls" });
    expect(withArgumentDefaults(served, "read", {})).toStrictEqual({});
  });
});

describe("served tool descriptions", () => {
  it("carry each tool's prompt guidelines", () => {
    const served = resolveServedTools(
      [{ ...tool("task_start"), description: "Start a job." }, tool("read")],
      [
        {
          name: "task_start",
          promptGuidelines: ["Do not poll task_list.", "  "],
        },
      ]
    );

    expect(served.tools.map(({ description }) => description)).toStrictEqual([
      "Start a job.\n\nGuidelines:\n- Do not poll task_list.",
      "",
    ]);
  });
});
