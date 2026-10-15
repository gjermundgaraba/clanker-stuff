import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import { mapToolArgs, piToolNameFor, resolveServedTools } from "../tools.js";

const tool = (name: string): Tool => ({ name, description: "", parameters: Type.Object({}) });

describe("served tool names", () => {
  it("serves every pi tool under the custom-tools MCP prefix", () => {
    const served = resolveServedTools([tool("read"), tool("ask_user")]);

    expect(served.toSdk.get("read")).toBe("mcp__custom-tools__read");
    expect(served.toSdk.get("ask_user")).toBe("mcp__custom-tools__ask_user");
    expect(served.tools.map(({ name }) => name)).toEqual(["read", "ask_user"]);
  });

  it("maps a served name back to the pi tool regardless of case", () => {
    const { toPi } = resolveServedTools([tool("WebFetch")]);

    expect(piToolNameFor("mcp__custom-tools__WebFetch", toPi)).toBe("WebFetch");
    expect(piToolNameFor("mcp__custom-tools__webfetch", toPi)).toBe("WebFetch");
    expect(piToolNameFor("MCP__CUSTOM-TOOLS__WEBFETCH", toPi)).toBe("WebFetch");
  });

  // Claude Code answers an invented builtin itself; forwarding it would run a tool
  // Claude Code never dispatched.
  it("does not resolve a name the bridge does not serve", () => {
    const { toPi } = resolveServedTools([tool("read")]);

    expect(piToolNameFor("Bash", toPi)).toBeUndefined();
    expect(piToolNameFor("read", toPi)).toBeUndefined();
    expect(piToolNameFor("mcp__other-server__read", toPi)).toBeUndefined();
  });

  it("serves nothing without tools", () => {
    const served = resolveServedTools(undefined);

    expect(served.tools).toEqual([]);
    expect(served.toPi.size).toBe(0);
  });
});

describe("mapToolArgs", () => {
  it("renames Claude Code's file_path to pi's path for read and write", () => {
    expect(mapToolArgs("read", { file_path: "/a", offset: 3 })).toEqual({ path: "/a", offset: 3 });
    expect(mapToolArgs("Write", { file_path: "/a", content: "x" })).toEqual({
      path: "/a",
      content: "x",
    });
  });

  it("renames edit's string arguments to pi's text ones", () => {
    expect(mapToolArgs("edit", { file_path: "/a", old_string: "x", new_string: "y" })).toEqual({
      path: "/a",
      oldText: "x",
      newText: "y",
    });
    expect(mapToolArgs("Edit", { path: "/a", old_text: "x", new_text: "y" })).toEqual({
      path: "/a",
      oldText: "x",
      newText: "y",
    });
  });

  it("keeps the first of two aliases for the same pi key", () => {
    expect(mapToolArgs("edit", { path: "/first", file_path: "/second" })).toEqual({
      path: "/first",
    });
    expect(mapToolArgs("edit", { old_string: "first", oldText: "second" })).toEqual({
      oldText: "first",
    });
  });

  it("passes other tools' arguments through untouched", () => {
    expect(mapToolArgs("grep", { file_path: "/a", pattern: "x" })).toEqual({
      file_path: "/a",
      pattern: "x",
    });
  });

  it("gives bash Claude Code's default timeout only when none is set", () => {
    expect(mapToolArgs("bash", { command: "ls" })).toEqual({ command: "ls", timeout: 120 });
    expect(mapToolArgs("Bash", { command: "ls", timeout: null })).toEqual({
      command: "ls",
      timeout: 120,
    });
    expect(mapToolArgs("bash", { command: "ls", timeout: 0 })).toEqual({
      command: "ls",
      timeout: 0,
    });
    expect(mapToolArgs("bash", { command: "ls", timeout: 5 })).toEqual({
      command: "ls",
      timeout: 5,
    });
  });
});
