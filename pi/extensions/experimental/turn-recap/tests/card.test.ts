import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

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
    [80, 6],
    [20, 24],
  ])("preserves current recap content at %i×%i", (width, rows) => {
    for (const expanded of [false, true]) {
      for (const recap of [
        { status: "pending" } as const,
        { status: "ready", text: "Review complete", usage: snapshot().metrics.usage } as const,
      ]) {
        const data = snapshot();
        data.recap = recap;

        const rendered = renderCard(
          { ...state(), snapshot: data, expanded, previousRecap: "Old recap" },
          width,
          createIdentityTheme(),
          rows,
        ).join("\n");

        expect(rendered).toContain(recap.status === "pending" ? "Generating recap…" : recap.text);
      }
    }
  });

  it("limits compact recap text to two lines without losing either counter", () => {
    const data = snapshot();
    data.recap = { status: "ready", text: "Recap ".repeat(50), usage: data.metrics.usage };

    const lines = renderCard({ ...state(), snapshot: data }, 80, createIdentityTheme(), 24);
    const recapLines = lines.filter((line) => line.includes("Recap"));

    expect(recapLines).toHaveLength(2);
    expect(recapLines.at(-1)).toContain("…");
    expect(lines.join("\n")).toContain("370 processed · ≈1.0k context");
    expect(lines).toHaveLength(5);
  });

  it("preserves expanded accounting with a multiline recap at 80×24", () => {
    const data = snapshot();
    data.recap = {
      status: "ready",
      text: "Review is complete. The parser handles empty input, preserves existing configuration, and reports invalid values clearly. Tests passed; no production changes or follow-up required",
      usage: data.metrics.usage,
    };

    const rendered = renderCard(
      { ...state(), snapshot: data, expanded: true },
      80,
      createIdentityTheme(),
      24,
    ).join("\n");

    expect(rendered).toContain("changes or follow-up required");
    expect(rendered).toContain("Reported cost $0.3300");
    expect(rendered).toContain("Recap only: 370 tokens · $0.3300 reported (excluded above)");
    expect(rendered.match(/context/giu)).toHaveLength(1);
  });

  it("uses available expanded height beyond twelve rows", () => {
    const data = snapshot();
    data.recap = { status: "ready", text: "Recap ".repeat(50), usage: data.metrics.usage };
    data.metrics.models = ["provider/" + "long-model-name-".repeat(15) + "final-model"];

    const lines = renderCard(
      { ...state(), snapshot: data, expanded: true },
      80,
      createIdentityTheme(),
      40,
    );

    expect(lines.length).toBeGreaterThan(12);
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines.join("\n")).toContain("final-model");
  });

  it.each([false, true])("preserves context percentage coloring, expanded=%s", (expanded) => {
    const data = snapshot();
    data.metrics.context = { tokens: 9000, contextWindow: 10000, percent: 90 };
    const theme = createIdentityTheme();
    const foreground = vi.spyOn(theme, "fg");

    renderCard({ ...state(), snapshot: data, expanded }, 80, theme, 24);

    expect(foreground).toHaveBeenCalledWith(
      "error",
      expanded ? "Context ≈9.0k/10.0k (90.0%)" : "≈9.0k context",
    );
  });

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

      expect(compact.join("\n").indexOf("Recap unavailable")).toBeLessThan(
        compact.join("\n").indexOf("processed"),
      );
      expect(compact.join("\n")).toContain("Recap unavailable");
      expect(compact.join("\n")).toContain("/turn-recap for details");

      const expanded = renderCard(
        { ...state(), snapshot: data, previousRecap, expanded: true },
        width,
        createIdentityTheme(),
        rows,
      );

      expect(expanded.join("\n")).toContain("Recap unavailable: No credentials for recap provider");
      expect(expanded.join("\n")).not.toContain("/turn-recap for details");
      expect(compact.length).toBeLessThanOrEqual(Math.min(5, Math.floor(rows / 2)));
      expect(expanded.length).toBeLessThanOrEqual(Math.floor(rows / 2));
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

    expect(lines.join("\n")).toContain(
      status === "pending" ? "Generating recap" : "Recap interrupted",
    );
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

    expect(lines.length).toBeLessThanOrEqual(expanded ? 20 : 5);
    expect(lines.join("\n")).toContain("Turn recap");
    expect(lines.join("\n")).toContain("Recap unavailable");
    expect(lines.at(-1)).toContain("…");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("clips oversized errors on narrow terminals without overflowing the call stack", () => {
    const data = snapshot();
    data.recap = { status: "failed", error: "failure ".repeat(140_000) };

    const lines = renderCard(
      { ...state(), snapshot: data, expanded: true },
      10,
      createIdentityTheme(),
      24,
    );

    expect(lines).toHaveLength(12);
    expect(lines.join("\n")).toContain("failure");
    expect(lines.at(-1)).toContain("…");
    expect(lines.every((line) => visibleWidth(line) <= 10)).toBe(true);
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

      expect(lines.length).toBeLessThanOrEqual(Math.floor(rows / 2));
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

  it("separates processed and context tokens and expands the usage breakdown", () => {
    const theme = createIdentityTheme();
    const compact = renderCard(state(), 100, theme, 40).join("\n");
    expect(compact).toContain("370 processed · ≈1.0k context");
    expect(compact.match(/context/giu)).toHaveLength(1);
    expect(compact).not.toContain("Reported cost");
    const detailed = renderCard({ ...state(), expanded: true }, 120, theme, 40).join("\n");
    expect(detailed).toContain("Cache read 200");
    expect(detailed).toContain("Reasoning 10 (included in output)");
    expect(detailed).toContain("Reported cost $0.3300");
    expect(detailed).toContain("370 processed · Context ≈1.0k/10.0k (10.0%)");
    expect(detailed.match(/context/giu)).toHaveLength(1);
  });

  it.each([false, true])("keeps both counters visible at 80 columns, running=%s", (running) => {
    const data = snapshot();
    data.metrics.usage.input = 120930;
    data.metrics.context = { tokens: 31000, contextWindow: 272000, percent: 11.4 };

    const lines = renderCard(
      { ...state(), snapshot: data, running },
      80,
      createIdentityTheme(),
      24,
    );

    expect(lines.join("\n")).toContain("121.2k processed · ≈31.0k context");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it.each([
    { context: undefined, label: "unavailable", detail: "unavailable context" },
    {
      context: { tokens: null, contextWindow: 10000, percent: null },
      label: "unknown",
      detail: "Context unknown/10.0k",
    },
    {
      context: { tokens: 0, contextWindow: 10000, percent: 0 },
      label: "≈0",
      detail: "Context ≈0/10.0k (0.0%)",
    },
  ])("renders $label without confusing missing context with zero", ({ context, label, detail }) => {
    const data = snapshot();

    if (context === undefined) delete data.metrics.context;
    else data.metrics.context = context;

    const lines = renderCard({ ...state(), snapshot: data }, 80, createIdentityTheme(), 24);

    expect(lines.join("\n")).toContain(`370 processed · ${label} context`);

    const detailed = renderCard(
      { ...state(), snapshot: data, expanded: true },
      80,
      createIdentityTheme(),
      40,
    ).join("\n");

    expect(detailed).toContain(detail);
    expect(detailed.match(/context/giu)).toHaveLength(1);
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
    expect(lines).toContain("370 processed");
    expect(lines).not.toContain("Generating recap");
  });
});
