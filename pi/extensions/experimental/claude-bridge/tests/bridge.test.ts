// History-rewrite marks: pi compacts or navigates while a Claude Code query sits parked at
// a tool boundary, and only the rewriting pi session's parked queries may be discarded.

import { describe, expect, it } from "vite-plus/test";

import { Bridge } from "../bridge.js";
import type { BridgeQuery } from "../child.js";
import { QueryContext } from "../query/context.js";
import type { McpResult } from "../query/tool-results.js";
import { discardRewrittenQuery } from "../stream.js";
import { createFakeQuery, fakeQueryFunction } from "./helpers.js";

const newBridge = (): Bridge => new Bridge(fakeQueryFunction().run);

/** A query parked mid-turn: Claude Code asked for a tool and is waiting on the answer. */
function parkQuery(
  bridge: Bridge,
  toolCallId: string,
  piSessionId: string,
): { c: QueryContext; sdkQuery: BridgeQuery } {
  const fake = createFakeQuery({ prompt: "", options: {} });

  const sdkQuery: BridgeQuery = {
    [Symbol.asyncIterator]: () => fake[Symbol.asyncIterator](),
    interrupt: () => fake.interrupt(),
    close: () => {
      fake.close();
    },
  };

  const c = new QueryContext();

  c.activeQuery = sdkQuery;
  c.piSessionId = piSessionId;
  c.turnToolCallIds = [toolCallId];
  c.pendingToolCalls.set(toolCallId, { toolName: "read", resolve: () => {} });
  bridge.activeQueries.add(c);

  return { c, sdkQuery };
}

const resultFor = (toolCallId: string): McpResult => ({
  toolCallId,
  content: [{ type: "text", text: "file contents" }],
});

describe("Bridge.markRebuild", () => {
  it("records the rewrite before any Claude Code session exists", () => {
    // The mirror is assigned when a query completes, so a session can have none for a
    // whole first turn, and a first turn is long enough to compact.
    const bridge = newBridge();

    expect(bridge.mirrors.get("pi-parent")).toBeUndefined();

    bridge.markRebuild("pi-parent", "session_compact:threshold");

    expect(bridge.mirrors.rewritten.has("pi-parent")).toBe(true);
  });

  it("arms only the parked queries of the rewriting pi session", () => {
    const bridge = newBridge();
    const parent = parkQuery(bridge, "call_1", "pi-parent");
    // The subagent parked inside the parent's tool call; its history was never rewritten.
    const subagent = parkQuery(bridge, "call_sub", "pi-subagent");

    bridge.markRebuild("pi-parent", "session_compact:threshold");

    expect(parent.c.historyStale).toBe(true);
    expect(subagent.c.historyStale).toBe(false);
  });

  it("arms nothing when the rewrite cannot be attributed", () => {
    const bridge = newBridge();
    const { c } = parkQuery(bridge, "call_1", "pi-parent");

    bridge.markRebuild(null, "session_compact:manual");

    expect(c.historyStale).toBe(false);
  });

  it("forces only the owning session's next sync down the rebuild path", () => {
    const bridge = newBridge();

    bridge.mirrors.set("pi-a", { sessionId: "abc", cursor: 3, cwd: "/tmp", piSessionId: "pi-a" });
    bridge.mirrors.set("pi-b", { sessionId: "def", cursor: 2, cwd: "/tmp", piSessionId: "pi-b" });

    bridge.markRebuild("pi-b", "session_compact:threshold");

    // A subagent's compaction must not rebuild the conversation it never touched.
    expect(bridge.mirrors.get("pi-a")?.needsRebuild).toBeUndefined();
    expect(bridge.mirrors.get("pi-b")?.needsRebuild).toBe(true);

    bridge.markRebuild(null, "session_compact:served");

    expect(bridge.mirrors.get("pi-a")?.needsRebuild).toBeUndefined();
    // Every reader of the discard set guards on a real pi session id, so an unattributed
    // entry could never be consumed, only leaked.
    expect([...bridge.mirrors.rewritten]).toEqual(["pi-b"]);
  });

  it("marks the unattributed mirror on an unattributed rewrite", () => {
    const bridge = newBridge();

    bridge.mirrors.set(null, { sessionId: "cc-none", cursor: 2, cwd: "/tmp" });

    bridge.markRebuild(null, "session_compact:manual");

    expect(bridge.mirrors.get(null)?.needsRebuild).toBe(true);
  });

  it("arms the replacement query after a second rewrite in the same turn", () => {
    // The first discard consumed the session's mark; a second compaction re-adds it and
    // must arm the replacement too.
    const bridge = newBridge();
    const first = parkQuery(bridge, "call_1", "pi-parent");

    bridge.markRebuild("pi-parent", "session_compact:threshold");
    discardRewrittenQuery(bridge, first.c);

    const replacement = parkQuery(bridge, "call_2", "pi-parent");

    expect(replacement.c.historyStale).toBe(false);

    bridge.markRebuild("pi-parent", "session_compact:threshold");

    expect(replacement.c.historyStale).toBe(true);
  });
});

describe("Bridge.armStaleContexts", () => {
  it("arms a query that parked after its session's rewrite was recorded", () => {
    const bridge = newBridge();

    bridge.markRebuild("pi-parent", "session_compact:threshold");

    const { c } = parkQuery(bridge, "call_1", "pi-parent");

    expect(c.historyStale).toBe(false);

    bridge.armStaleContexts();

    expect(c.historyStale).toBe(true);
  });
});

describe("Bridge.contextForToolResults", () => {
  it("routes a result to the parked query that issued its call", () => {
    const bridge = newBridge();
    const parent = parkQuery(bridge, "call_parent", "pi-parent");
    const subagent = parkQuery(bridge, "call_sub", "pi-subagent");

    expect(bridge.contextForToolResults([resultFor("call_parent")])).toBe(parent.c);
    expect(bridge.contextForToolResults([resultFor("call_sub")])).toBe(subagent.c);
    expect(bridge.contextForToolResults([resultFor("call_unknown")])).toBeUndefined();
  });

  it("does not route to a context that left the routing set", () => {
    const bridge = newBridge();
    const { c } = parkQuery(bridge, "call_1", "pi-parent");

    bridge.activeQueries.delete(c);

    expect(bridge.contextForToolResults([resultFor("call_1")])).toBeUndefined();
  });
});

describe("Bridge.missedSteer", () => {
  it("forces a rebuild of the query's own session only", () => {
    const bridge = newBridge();
    const c = new QueryContext();

    c.piSessionId = "pi-a";
    bridge.mirrors.set("pi-a", { sessionId: "cc-a", cursor: 4, cwd: "/tmp", piSessionId: "pi-a" });
    bridge.mirrors.set("pi-b", { sessionId: "cc-b", cursor: 4, cwd: "/tmp", piSessionId: "pi-b" });

    bridge.missedSteer(c, "missed steer");

    expect(c.missedSteer).toBe(true);
    expect(bridge.mirrors.get("pi-a")?.needsRebuild).toBe(true);
    expect(bridge.mirrors.get("pi-b")?.needsRebuild).toBeUndefined();
  });
});
