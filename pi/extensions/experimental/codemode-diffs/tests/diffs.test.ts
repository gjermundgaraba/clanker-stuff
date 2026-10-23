import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { EditDiffs } from "../diffs.js";

const call = (id: string): ToolCallEvent => ({
  type: "tool_call",
  toolName: "codemode",
  toolCallId: id,
  input: { code: "" },
});

const result = (
  name: string,
  id: string,
  details: unknown,
  parentToolCallId?: string,
  isError = false,
): ToolResultEvent => ({
  type: "tool_result",
  toolName: name,
  toolCallId: id,
  ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
  input: { path: "file.txt" },
  content: [],
  details,
  isError,
});

describe("edit diff capture", () => {
  it("ignores direct edits, unrelated parents, failed edits, and unsupported override results", () => {
    const diffs = new EditDiffs();
    diffs.onCall(call("script"));
    diffs.onResult(result("edit", "direct", { diff: "direct" }));
    diffs.onResult(result("edit", "other/1", { diff: "other" }, "other"));
    diffs.onResult(result("edit", "script/1", { diff: "failed" }, "script", true));
    diffs.onResult(result("edit", "script/2", { diff: 12 }, "script"));
    diffs.onResult(result("edit", "script/3", undefined, "script"));
    diffs.onResult(result("write", "script/4", { diff: "write" }, "script"));
    expect(diffs.onResult(result("codemode", "script", { calls: [] }))).toBeUndefined();
  });

  it("drops captured syntax when a result hook changes the diff, and clears pending capture", () => {
    const diffs = new EditDiffs();
    diffs.onCall(call("script"));
    diffs.onCall({
      type: "tool_call",
      toolName: "edit",
      toolCallId: "script/1",
      parentToolCallId: "script",
      input: { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] },
    });
    expect(diffs.isCapturing("script/1")).toBe(true);
    diffs.setSyntax("script/1", "+1 original", [[[8, "string"]]]);
    diffs.onResult(result("edit", "script/1", { diff: "+1 redacted" }, "script"));
    expect(diffs.isCapturing("script/1")).toBe(false);
    expect(diffs.onResult(result("codemode", "script", {}))).toEqual({
      details: {
        codemodeDiffs: [{ toolCallId: "script/1", path: "file.txt", diff: "+1 redacted" }],
      },
    });
    diffs.clear();
    diffs.setSyntax("script/1", "+1 late", [[[4, "text"]]]);
    expect(diffs.isCapturing("script/1")).toBe(false);
  });

  it("releases completed and abandoned calls so later results cannot inherit their diffs", () => {
    const diffs = new EditDiffs();
    diffs.onCall(call("completed"));
    diffs.onResult(result("edit", "completed/1", { diff: "+1 change" }, "completed"));
    expect(diffs.onResult(result("codemode", "completed", undefined))).toEqual({
      details: {
        codemodeDiffs: [{ toolCallId: "completed/1", path: "file.txt", diff: "+1 change" }],
      },
    });
    expect(diffs.onResult(result("codemode", "completed", undefined))).toBeUndefined();

    diffs.onCall(call("abandoned"));
    diffs.onResult(result("edit", "abandoned/1", { diff: "+1 abandoned" }, "abandoned"));
    diffs.clear();
    expect(diffs.onResult(result("codemode", "abandoned", undefined))).toBeUndefined();
    diffs.onCall(call("abandoned"));
    expect(diffs.onResult(result("codemode", "abandoned", undefined))).toBeUndefined();
  });
});
