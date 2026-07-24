import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { createIdentityTheme } from "../../tests/harness/tui.js";
import type { FooterState } from "../footer.js";
import { renderFooter } from "../footer.js";
import type { UsageSnapshot } from "../types.js";

const theme = createIdentityTheme();

const NOW = Date.parse("2026-07-21T12:00:00.000Z");

const baseState = (overrides: Partial<FooterState> = {}): FooterState => ({
  context: { percent: 40, total: 200_000, used: 80_000 },
  cwd: "/Users/dev/code/project",
  git: { ahead: 0, behind: 0, branch: "main", dirty: false },
  home: "/Users/dev",
  modelName: "gpt-5",
  nowMs: NOW,
  reasoning: true,
  thinkingLevel: "high",
  usage: null,
  ...overrides,
});

const codexUsage = (): UsageSnapshot => ({
  fetchedAt: NOW,
  planLabel: "plus",
  provider: "openai-codex",
  windows: [
    {
      id: "5h",
      label: "5h",
      remainingPercent: 68,
      resetsAt: new Date(NOW + 2 * 3_600_000).toISOString(),
    },
    {
      id: "7d",
      label: "7d",
      remainingPercent: 34,
      resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
    },
  ],
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
});

describe("footer usage line", () => {
  it("renders provider windows as used-percent bars with resets", () => {
    const lines = renderFooter(baseState({ usage: codexUsage() }), 120, theme);
    expect(lines).toHaveLength(2);
    const usageLine = lines[1] ?? "";
    expect(
      ["Codex (plus)", "5h", "32%", "2h", "7d", "66%", "3d", "━"].every(
        (fragment) => usageLine.includes(fragment)
      )
    ).toBeTruthy();
  });

  it("keeps every line within the width budget", () => {
    for (const width of [30, 55, 80]) {
      const lines = renderFooter(
        baseState({ usage: codexUsage() }),
        width,
        theme
      );
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("renders no usage line without a snapshot", () => {
    const lines = renderFooter(baseState({ usage: null }), 120, theme);
    expect(lines).toHaveLength(1);
  });
});
