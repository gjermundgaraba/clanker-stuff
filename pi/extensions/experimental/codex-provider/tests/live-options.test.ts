import { describe, expect, it } from "vite-plus/test";

import {
  parseLiveInvocation,
  parseTransport,
  usesRealWindow,
} from "../scripts/live-multi-compaction-options.js";

const parse = (
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
) => parseLiveInvocation(args, environment);

describe("live multi-compaction options", () => {
  it.each([
    [[], "standard", 3],
    [["--branch"], "branch", 2],
    [["--capabilities"], "capabilities", 3],
    [["--portable"], "portable", 3],
    [["--real-window"], "real-window", 2],
    [["--mid-turn"], "mid-turn", 2],
    [["--soak"], "soak", 10],
    [["--stream-fault"], "stream-fault", 2],
    [["--threshold"], "threshold", 3],
  ] as const)("parses %j as the %s scenario with %i rounds", (args, kind, rounds) => {
    expect(parse(args)).toMatchObject({
      kind,
      process: "parent",
      rounds,
      transport: "sse",
    });
  });

  it.each([
    ["branch", "CODEX_COMPACTION_BRANCH_TRANSPORT", "--branch-child"],
    ["restart", "CODEX_COMPACTION_RESTART_TRANSPORT", "--restart-child"],
  ] as const)("parses the internal %s child transport", (_label, name, flag) => {
    expect(parse([flag], { [name]: "websocket" })).toStrictEqual({
      kind: flag.slice(2),
      process: "child",
      transport: "websocket",
    });
  });

  it.each([
    [[], "fallback", "--fallback"],
    [[], "sse", "--sse"],
    [[], "websocket", "--websocket"],
    [["--real-window"], "fallback", "--fallback"],
    [["--mid-turn"], "fallback", "--fallback"],
  ] as const)("allows %j with %s", (scenario, transport, flag) => {
    expect(parse([...scenario, flag])).toMatchObject({ transport });
  });

  it.each([
    [["--portable", "--fallback"], "Portable canary requires SSE"],
    [["--real-window", "--websocket"], "Real-window and mid-turn canaries require SSE"],
    [["--mid-turn", "--websocket"], "Real-window and mid-turn canaries require SSE"],
    [["--stream-fault", "--fallback"], "Stream-fault canary requires SSE"],
    [["--stream-fault", "--websocket"], "Stream-fault canary requires SSE"],
  ] as const)("rejects incompatible flags %j", (args, message) => {
    expect(() => parse(args)).toThrow(message);
  });

  it.each([
    ["standard", []],
    ["branch", ["--branch"]],
    ["real-window", ["--real-window"]],
    ["mid-turn", ["--mid-turn"]],
    ["soak", ["--soak"]],
    ["stream-fault", ["--stream-fault"]],
  ] as const)("requires two rounds for %s", (_kind, args) => {
    expect(() => parse(args, { CODEX_COMPACTION_LIVE_ROUNDS: "1" })).toThrow(
      "Live canary requires at least 2 compactions",
    );
  });

  it.each([
    ["capabilities", ["--capabilities"]],
    ["portable", ["--portable"]],
    ["threshold", ["--threshold"]],
  ] as const)("allows one round for %s", (kind, args) => {
    expect(parse(args, { CODEX_COMPACTION_LIVE_ROUNDS: "1" })).toMatchObject({
      kind,
      rounds: 1,
    });
  });

  it("validates the rounds override as a positive safe integer", () => {
    expect(() => parse([], { CODEX_COMPACTION_LIVE_ROUNDS: "1.5" })).toThrow(
      "CODEX_COMPACTION_LIVE_ROUNDS must be a positive safe integer",
    );
  });

  it.each([
    [["--branch", "--soak"], "Choose only one behavior mode", {}],
    [
      ["--branch-child", "--restart-child"],
      "Choose only one child mode",
      {
        CODEX_COMPACTION_BRANCH_TRANSPORT: "sse",
        CODEX_COMPACTION_RESTART_TRANSPORT: "sse",
      },
    ],
    [
      ["--branch", "--branch-child"],
      "Parent behavior modes cannot be combined with child modes",
      { CODEX_COMPACTION_BRANCH_TRANSPORT: "sse" },
    ],
    [["--sse", "--fallback"], "Choose only one transport", {}],
  ] as const)("rejects conflicting flags %j", (args, message, environment) => {
    expect(() => parse(args, environment)).toThrow(message);
  });

  it("does not let an invalid rounds environment block help", () => {
    expect(parse(["--help"], { CODEX_COMPACTION_LIVE_ROUNDS: "invalid" })).toMatchObject({
      kind: "standard",
      rounds: 3,
      showHelp: true,
    });
  });

  it("validates transport values and retains mid-turn real-window semantics", () => {
    expect(() => parseTransport("auto")).toThrow("Unknown transport mode: auto");
    expect(usesRealWindow("mid-turn")).toBeTruthy();
    expect(usesRealWindow("real-window")).toBeTruthy();
    expect(usesRealWindow("standard")).toBeFalsy();
  });
});
