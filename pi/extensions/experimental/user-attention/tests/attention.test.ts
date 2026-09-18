import { beforeAll, expect, it } from "vite-plus/test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import { toolRenderContext } from "../../../../tests/harness/tool-rendering.js";
import { renderCall, renderResult } from "../attention.js";

beforeAll(() => initTheme("dark"));

it("renders literal, safe, bounded attention previews and honest result state", () => {
  const theme = createIdentityTheme();
  const context = { ...toolRenderContext(), args: { message: "Test" } };
  const hostile = "\x1b[2J\u202e";

  const view = renderCall(
    { message: "**literal**\n" + "中文".repeat(500) + hostile },
    theme,
    context,
  );

  expect(view.render(80).join("\n")).toContain("**literal**");

  for (const width of [1, 2, 20, 80]) {
    const rows = view.render(width);
    expect(rows.length).toBeLessThanOrEqual(6);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    expect(rows.join("\n")).not.toContain("\x1b[2J");
    expect(rows.join("\n")).not.toContain("\u202e");
  }

  for (const isError of [false, true])
    for (const isPartial of [false, true]) {
      const result = renderResult(
        {
          content: [{ type: "text", text: "Recorded response" + hostile }],
          details: { accepted: true },
        },
        { expanded: false, isPartial },
        theme,
        { ...context, isError },
      );

      expect(result.render(80).join("\n").trimEnd()).toBe(
        isError || isPartial ? "Recorded response" : "✓ Message submitted",
      );
    }
});
