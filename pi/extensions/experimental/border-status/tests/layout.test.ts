import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";
import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import { renderBorder } from "../layout.js";
import type { StatusEntry } from "../layout.js";

const theme = createIdentityTheme();

const color = (s: string) => `\x1b[34m${s}\x1b[0m`;

const entry: StatusEntry = {
  owner: "questions",
  key: "inbox",
  status: { text: "3", icon: { unicode: "✉", ascii: "mail", nerd: "\uF0E0" }, priority: 100 },
};

const render = (line: string, entries: StatusEntry[] = [entry]) =>
  renderBorder(line, visibleWidth(line), entries, "unicode", theme, color);

describe("border layout", () => {
  it("preserves working and scroll labels and uses only the trailing rule", () => {
    const original = color("── ◉ Working ─── ↑ 2 more ────────────────────");
    const result = render(original);
    expect(stripTerminalSequences(result)).toBe("── ◉ Working ─── ↑ 2 more ────────────── ✉ 3 ─");
    expect(visibleWidth(result)).toBe(visibleWidth(original));
    expect(render(original, [])).toBe(original);
  });
  it("keeps high priority and deterministically drops whole entries", () => {
    const lower: StatusEntry = { owner: "other", key: "x", status: { text: "lower", priority: 0 } };
    const original = "─".repeat(12);
    expect(stripTerminalSequences(render(original, [lower, entry]))).toBe("────── ✉ 3 ─");
    expect(render(original, [entry, lower])).toBe(render(original, [lower, entry]));
  });
  it("never exceeds available width or overwrites left content", () => {
    for (let width = 1; width < 80; width++) {
      const original = "─".repeat(width);
      expect(visibleWidth(render(original))).toBe(width);
    }

    const original = "── Working ──";
    expect(render(original)).toBe(original);
    expect(render("unsupported editor border")).toBe("unsupported editor border");
    const wide = render("─".repeat(16), [{ owner: "x", key: "x", status: { text: "界界" } }]);
    expect(visibleWidth(wide)).toBe(16);
  });
});

it.each(["👩‍💻", "می\u200Cروم"])("preserves joined display content and border width: %s", (text) => {
  const result = render("─".repeat(40), [
    { owner: "joined", key: "display", status: { text, icon: { unicode: "👩‍💻" } } },
  ]);

  expect(stripTerminalSequences(result)).toContain(`👩‍💻 ${text}`);
  expect(visibleWidth(result)).toBe(40);
});
