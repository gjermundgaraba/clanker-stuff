import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";

import { renderCard } from "../card.js";
import type { CardState } from "../card.js";
import { snapshot } from "./fixtures.js";
import { createIdentityTheme } from "../../../../tests/harness/tui.js";

const state = (): CardState => ({
  snapshot: snapshot(),
  running: false,
  waiting: false,
  expanded: false,
  previousRecap: undefined,
});

describe("pinned card", () => {
  it.each([
    [80, 10],
    [80, 24],
    [120, 40],
  ])(
    "keeps failure status and expanded explanation ahead of previous text at %i×%i",
    (width, rows) => {
      const data = snapshot();
      data.recap = { status: "failed", error: "No credentials for recap provider" };
      const previousRecap = "A ".repeat(149) + "AB";

      const compact = renderCard(
        { ...state(), snapshot: data, previousRecap },
        width,
        createIdentityTheme(),
        rows,
      );

      expect(compact[2]).toContain("Recap unavailable");
      expect(compact.join("\n")).toContain("/turn-recap for details");

      const expanded = renderCard(
        { ...state(), snapshot: data, previousRecap, expanded: true },
        width,
        createIdentityTheme(),
        rows,
      );

      expect(expanded[2]).toContain("Recap unavailable: No credentials for recap provider");
      expect(expanded.join("\n")).not.toContain("/turn-recap for details");
      expect(compact.length).toBeLessThanOrEqual(Math.min(5, Math.floor(rows / 2)));
      expect(expanded.length).toBeLessThanOrEqual(Math.min(12, Math.floor(rows / 2)));
    },
  );

  it.each(["pending", "cancelled"] as const)("keeps %s status ahead of previous text", (status) => {
    const data = snapshot();
    data.recap = { status };

    const lines = renderCard(
      { ...state(), snapshot: data, previousRecap: "A".repeat(320) },
      80,
      createIdentityTheme(),
      24,
    );

    expect(lines[2]).toContain(status === "pending" ? "Generating recap" : "Recap interrupted");
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it.each([false, true])("bounds multiline persisted text and errors, expanded=%s", (expanded) => {
    const data = snapshot();
    data.recap = { status: "failed", error: "failure\n".repeat(10_000) };

    const lines = renderCard(
      { ...state(), snapshot: data, expanded, previousRecap: Array(160).fill("x").join("\n") },
      80,
      createIdentityTheme(),
      40,
    );

    expect(lines.length).toBeLessThanOrEqual(expanded ? 12 : 5);
    expect(lines[0]).toContain("Turn recap");
    expect(lines[1]).toContain("370 tokens");
    expect(lines.at(-1)).toContain("…");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it.each([0, 1, 2, 4, 6, 12, 24, 40])("uses at most half of a %i-row terminal", (rows) => {
    for (const width of [1, 2, 10, 80]) {
      const data = snapshot();
      data.recap = { status: "ready", text: "🦄".repeat(160), usage: data.metrics.usage };

      const lines = renderCard(
        { ...state(), snapshot: data, expanded: true },
        width,
        createIdentityTheme(),
        rows,
      );

      expect(lines.length).toBeLessThanOrEqual(Math.min(12, Math.floor(rows / 2)));
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it.each([0, 1, 2, 10, 40, 80, 140])(
    "fits width %i with expanded diagnostics and Unicode recap",
    (width) => {
      const data = snapshot();
      data.recap = {
        status: "ready",
        text: "🦄 Parser ready.\nNext: test it.",
        usage: data.metrics.usage,
      };

      const lines = renderCard(
        { ...state(), snapshot: data, expanded: true },
        width,
        createIdentityTheme(),
        40,
      );

      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);

      if (width === 0) expect(lines).toEqual([]);
    },
  );

  it("shows compact totals and expands cost, cache, reasoning and context", () => {
    const theme = createIdentityTheme();
    const compact = renderCard(state(), 100, theme, 40).join("\n");
    expect(compact).toContain("370 tokens");
    expect(compact).not.toContain("Reported cost");
    const detailed = renderCard({ ...state(), expanded: true }, 120, theme, 40).join("\n");
    expect(detailed).toContain("Cache read 200");
    expect(detailed).toContain("Reasoning 10 (included in output)");
    expect(detailed).toContain("Reported cost $0.3300");
    expect(detailed).toContain("Context ≈ 1.0k / 10.0k (10.0%)");
  });

  it("labels previous text while running or waiting for a recap and sanitizes persisted content", () => {
    const data = snapshot();
    data.recap = { status: "pending" };

    const lines = renderCard(
      {
        ...state(),
        snapshot: data,
        previousRecap: "\u001B[31mDone\u001B[0m\u0007\u202E",
        running: true,
      },
      100,
      createIdentityTheme(),
      40,
    ).join("\n");

    expect(lines).toContain("Previous recap: Done");
    expect(stripTerminalSequences(lines)).not.toContain("\u001B");
    expect(lines).not.toContain("\u202E");
    expect(lines).toContain("tokens reported");
    expect(lines).not.toContain("Generating recap");
  });
});
