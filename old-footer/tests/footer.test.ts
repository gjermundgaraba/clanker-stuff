import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { createIdentityTheme } from "../../tests/harness/tui.js";
import type { FooterState } from "../footer.js";
import { renderFooter } from "../footer.js";

const theme = createIdentityTheme();

const baseState = (overrides: Partial<FooterState> = {}): FooterState => ({
  codexFast: false,
  context: { percent: 40, total: 200_000, used: 80_000 },
  cwd: "/Users/dev/code/project",
  extensionStatuses: [],
  git: { ahead: 0, behind: 0, branch: "main", dirty: false },
  home: "/Users/dev",
  modelName: "gpt-5",
  reasoning: true,
  thinkingLevel: "high",
  ...overrides,
});

describe("footer status line", () => {
  it("renders cwd, branch, model, thinking level, and context gauge on one line when wide", () => {
    const lines = renderFooter(baseState(), 120, theme);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(
      [
        "~/code/project",
        "main",
        "gpt-5",
        "high",
        "ctx ",
        "40%",
        "80k/200k",
      ].every((fragment) => line.includes(fragment))
    ).toBeTruthy();
  });

  it("wraps into stacked lines on narrow terminals", () => {
    const lines = renderFooter(baseState(), 40, theme);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("does not shorten a sibling path that shares the home prefix", () => {
    const [line] = renderFooter(
      baseState({ cwd: "/Users/dev-work/project" }),
      120,
      theme
    );
    expect(line).toContain("/Users/dev-work/project");
    expect(line).not.toContain("~-work");
  });

  it("shows git dirty marker and ahead/behind counts", () => {
    const lines = renderFooter(
      baseState({
        git: { ahead: 2, behind: 1, branch: "main", dirty: true },
      }),
      120,
      theme
    );
    expect(lines[0]).toContain("main * ↑2 ↓1");
  });

  it("omits the thinking level when off or not a reasoning model", () => {
    expect(
      renderFooter(baseState({ thinkingLevel: "off" }), 120, theme)[0]
    ).not.toContain(" > off");
    expect(
      renderFooter(baseState({ reasoning: false }), 120, theme)[0]
    ).not.toContain("high");
  });

  it("shows a lightning symbol when Codex fast mode is active", () => {
    expect(
      renderFooter(baseState({ codexFast: true }), 120, theme)[0]
    ).toContain("gpt-5 ⚡");
  });

  it("renders extension statuses", () => {
    const lines = renderFooter(
      baseState({ extensionStatuses: ["🎙 voice", "⏱ 12s"] }),
      120,
      theme
    );

    expect(lines[0]).not.toContain("🎙 voice");
    expect(lines[1]).toBe("🎙 voice ⏱ 12s");
  });
});
