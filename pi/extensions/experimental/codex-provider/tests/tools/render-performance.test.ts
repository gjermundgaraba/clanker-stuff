import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { createMockTui } from "../../../../../tests/harness/tui.js";
import { applyPatchRenderers, stripAnsi } from "../../tools/renderers.js";
import { observeRenderWork } from "../fixtures/render-work.js";

beforeAll(() => initTheme("dark"));

describe("patch header render work", () => {
  it("prepares arguments once, rewraps without reformatting, and refreshes from completed metadata", () => {
    let reads = 0;
    const args = {
      get patch() {
        reads += 1;
        return "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch";
      },
    };
    const row = new ToolExecutionComponent(
      "apply_patch",
      "patch",
      args,
      { showImages: false },
      applyPatchRenderers,
      createMockTui(),
      "/tmp",
    );
    const work = observeRenderWork();
    expect(reads).toBe(0);
    expect(stripAnsi(row.render(80).join("\n"))).toContain("apply_patch Delete old.txt");
    const preparedReads = reads;
    expect(preparedReads).toBeGreaterThan(0);
    work.layouts.mockClear();
    row.render(80);
    expect(work.layouts).not.toHaveBeenCalled();
    row.render(40);
    expect(work.layouts).toHaveBeenCalled();
    expect(reads).toBe(preparedReads);

    row.updateResult({
      content: [],
      isError: false,
      details: {
        changes: [
          { kind: "delete", path: "old.txt", changed: true, lines: { added: 0, removed: 3 } },
        ],
        diffs: [],
      },
    });
    expect(stripAnsi(row.render(80).join("\n"))).toContain("old.txt (+0 -3)");
    const completedReads = reads;
    work.layouts.mockClear();
    row.render(80);
    expect(work.layouts).not.toHaveBeenCalled();
    expect(reads).toBe(completedReads);
  });

  it("uses complete metadata on the first ever draw, including when expanded", () => {
    const row = new ToolExecutionComponent(
      "apply_patch",
      "patch",
      { patch: "*** Begin Patch\n*** Add File: cut.txt\n[value truncated]" },
      { showImages: false },
      applyPatchRenderers,
      createMockTui(),
      "/tmp",
    );
    row.updateResult({
      content: [],
      isError: false,
      details: {
        changes: [
          { kind: "add", path: "complete.txt", changed: true, lines: { added: 9000, removed: 0 } },
        ],
        diffs: [],
      },
    });
    for (const expanded of [false, true]) {
      row.setExpanded(expanded);
      const rendered = stripAnsi(row.render(80).join("\n"));
      expect(rendered).toContain("complete.txt (+9000 -0)");
      expect(rendered).not.toContain("cut.txt");
    }
  });
});
