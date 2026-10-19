import { beforeAll, expect, it } from "vite-plus/test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import { renderedRows, toolRenderContext } from "../../../../tests/harness/tool-rendering.js";
import { renderCall } from "../attention.js";

beforeAll(() => initTheme("dark"));

it("renders the call as the safe, bounded record of the message", () => {
  const theme = createIdentityTheme();
  const hostile = "\x1b[2J\u202e";
  const args = { message: "Deploy **blocked**\n\n" + "中文".repeat(500) + hostile };

  const view = renderCall(args, theme, { ...toolRenderContext(), args });

  const text = renderedRows(view).join("\n");
  expect(text).toContain("Message for you");
  expect(text).toContain("Deploy blocked");
  expect(text).not.toContain("**");

  for (const width of [1, 2, 20, 80]) {
    const rows = view.render(width);
    expect(rows.length).toBeLessThanOrEqual(13);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    expect(rows.join("\n")).not.toContain("\x1b[2J");
    expect(rows.join("\n")).not.toContain("\u202e");
  }

  const expandedArgs = { message: "中文".repeat(500) + "END" };

  const expanded = renderCall(expandedArgs, theme, {
    ...toolRenderContext({ expanded: true }),
    args: expandedArgs,
  });

  expect(renderedRows(expanded).join("")).toContain("END");
});
