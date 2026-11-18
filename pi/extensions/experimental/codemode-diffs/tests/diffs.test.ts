import type {
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { EditDiffs, MAX_DIFF_DETAILS_BYTES } from "../diffs.js";

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
  isError = false
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
    diffs.onResult(
      result("edit", "script/1", { diff: "failed" }, "script", true)
    );
    diffs.onResult(result("edit", "script/2", { diff: 12 }, "script"));
    diffs.onResult(result("edit", "script/3", undefined, "script"));
    diffs.onResult(result("write", "script/4", { diff: "write" }, "script"));
    expect(
      diffs.onResult(result("codemode", "script", { calls: [] }))
    ).toBeUndefined();
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
    diffs.onResult(
      result("edit", "script/1", { diff: "+1 redacted" }, "script")
    );
    expect(diffs.isCapturing("script/1")).toBe(false);
    expect(diffs.onResult(result("codemode", "script", {}))).toStrictEqual({
      details: {
        codemodeDiffs: [
          { toolCallId: "script/1", path: "file.txt", diff: "+1 redacted" },
        ],
      },
    });
    diffs.clear();
    diffs.setSyntax("script/1", "+1 late", [[[4, "text"]]]);
    expect(diffs.isCapturing("script/1")).toBe(false);
  });

  it("caps serialized details per parent, counting escaped and multibyte text and keeping later small diffs", () => {
    const diffs = new EditDiffs();
    diffs.onCall(call("script"));
    diffs.onCall(call("peer"));

    const bulk = `+1 ${'界"\u0000'.repeat(5900)}`;
    const small = "+1 retained after omissions";
    const wouldFitWithoutOmissionField = `+1 ${"x".repeat(410)}`;
    diffs.onResult(result("edit", "script/1", { diff: bulk }, "script"));

    for (let i = 2; i <= 13; i += 1) {
      diffs.onResult(result("edit", `script/${i}`, { diff: bulk }, "script"));
    }

    diffs.onResult(result("edit", "script/14", { diff: small }, "script"));
    diffs.onResult(
      result(
        "edit",
        "script/15",
        { diff: wouldFitWithoutOmissionField },
        "script"
      )
    );
    diffs.onResult(result("edit", "peer/1", { diff: bulk }, "peer"));

    const final = diffs.onResult(
      result("codemode", "script", undefined)
    )?.details;

    expect(Buffer.byteLength(JSON.stringify(final))).toBeLessThanOrEqual(
      MAX_DIFF_DETAILS_BYTES
    );
    expect(final).toStrictEqual({
      codemodeDiffs: [
        { toolCallId: "script/1", path: "file.txt", diff: bulk },
        { toolCallId: "script/14", path: "file.txt", diff: small },
      ],
      codemodeDiffsOmitted: 13,
    });
    expect(
      diffs.onResult(result("codemode", "peer", undefined))?.details
    ).toStrictEqual({
      codemodeDiffs: [{ toolCallId: "peer/1", path: "file.txt", diff: bulk }],
    });
  });

  it("drops syntax rather than omitting a diff whose plain text fits", () => {
    const diffs = new EditDiffs();
    diffs.onCall(call("script"));
    diffs.onCall({
      type: "tool_call",
      toolName: "edit",
      toolCallId: "script/1",
      parentToolCallId: "script",
      input: { path: "file.txt" },
    });

    const line = "x+".repeat(3000);
    const diff = `+1 ${line}`;
    diffs.setSyntax("script/1", diff, [
      Array.from({ length: line.length }, (_, i) => [
        i + 1,
        i % 2 === 0 ? "variable" : "operator",
      ]),
    ]);
    diffs.onResult(result("edit", "script/1", { diff }, "script"));

    const final = diffs.onResult(
      result("codemode", "script", undefined)
    )?.details;

    expect(Buffer.byteLength(JSON.stringify(final))).toBeLessThanOrEqual(
      MAX_DIFF_DETAILS_BYTES
    );
    expect(final).toStrictEqual({
      codemodeDiffs: [{ toolCallId: "script/1", path: "file.txt", diff }],
    });
  });

  it("saves an omission count even when no diffs fit, including path and ID bytes", () => {
    const diffs = new EditDiffs();
    diffs.onCall(call("script"));
    diffs.onResult({
      ...result(
        "edit",
        `script/${"x".repeat(30_000)}`,
        { diff: "+1 small" },
        "script"
      ),
      input: { path: "界".repeat(13_000) },
    });

    expect(
      diffs.onResult(result("codemode", "script", undefined))?.details
    ).toStrictEqual({
      codemodeDiffs: [],
      codemodeDiffsOmitted: 1,
    });
  });

  it("releases completed and abandoned calls so later results cannot inherit their diffs", () => {
    const diffs = new EditDiffs();
    diffs.onCall(call("completed"));
    diffs.onResult(
      result("edit", "completed/1", { diff: "+1 change" }, "completed")
    );
    expect(
      diffs.onResult(result("codemode", "completed", undefined))
    ).toStrictEqual({
      details: {
        codemodeDiffs: [
          { toolCallId: "completed/1", path: "file.txt", diff: "+1 change" },
        ],
      },
    });
    expect(
      diffs.onResult(result("codemode", "completed", undefined))
    ).toBeUndefined();

    diffs.onCall(call("abandoned"));
    diffs.onResult(
      result("edit", "abandoned/1", { diff: "+1 abandoned" }, "abandoned")
    );
    diffs.clear();
    expect(
      diffs.onResult(result("codemode", "abandoned", undefined))
    ).toBeUndefined();
    diffs.onCall(call("abandoned"));
    expect(
      diffs.onResult(result("codemode", "abandoned", undefined))
    ).toBeUndefined();
  });
});
