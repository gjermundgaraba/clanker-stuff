import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderCard, renderLive } from "../card.js";
import type { LiveState, RecapView } from "../card.js";
import type { Snapshot } from "../entry.js";
import { snapshot } from "./fixtures.js";
import { createIdentityTheme } from "../../../../tests/harness/tui.js";

interface CardInput {
  data: Snapshot;
  recap?: RecapView;
}

const card = ({ data, recap }: CardInput = { data: snapshot() }, expanded = false, width = 100) =>
  renderCard(data, recap, width, createIdentityTheme(), expanded).map(stripTerminalSequences);

const withRecap = (recap: RecapView): CardInput => ({ data: snapshot(), recap });

const running = (paused = false): LiveState => ({
  activeMs: 1500,
  paused,
  metrics: snapshot().metrics,
});

describe("transcript card", () => {
  it.each([
    ["completed", "Completed in 1.5s at ", "muted"],
    ["aborted", "Aborted after 1.5s at ", "muted"],
    ["error", "Failed after 1.5s at ", "error"],
  ] as const)("titles a %s run with its duration and finish time", (outcome, title, tone) => {
    const theme = createIdentityTheme();
    const foreground = vi.spyOn(theme, "fg");

    const [heading] = renderCard({ ...snapshot(), outcome }, undefined, 100, theme, false);

    expect(heading).toMatch(new RegExp(`^─ Turn recap · ${title}`, "u"));
    expect(foreground).toHaveBeenCalledWith(
      tone,
      expect.stringMatching(new RegExp(`^${title}`, "u")),
    );
  });

  it("separates recap prose from statistics with one blank row", () => {
    const stats = "  3 tools · 370 processed · +400 context";

    expect(
      card(
        withRecap({ status: "ready", text: "Review complete", usage: snapshot().metrics.usage }),
      ).slice(1),
    ).toEqual(["  Review complete", "", stats]);
    expect(card().slice(1)).toEqual([stats]);
  });

  it("shows the whole recap without a row limit", () => {
    const text = `${"word ".repeat(62)}final`;

    const lines = card(
      withRecap({ status: "ready", text, usage: snapshot().metrics.usage }),
      false,
      40,
    );

    expect(lines.join(" ")).toContain("word final");
    expect(lines.join("")).not.toContain("…");
  });

  it("keeps a failure to one row until expanded", () => {
    const failed = withRecap({ status: "failed", error: `${"No credentials ".repeat(20)}final` });

    const compact = card(failed, false, 80);
    expect(compact).toHaveLength(4);
    expect(compact[1]).toMatch(/^ {2}Recap unavailable: No credentials .*…$/u);
    expect(card(failed, true, 80).join(" ")).toContain("credentials final");
  });

  it("shows a recap being generated where the recap will go", () => {
    expect(card(withRecap({ status: "generating" })).slice(1)).toEqual([
      "  Generating recap…",
      "",
      "  3 tools · 370 processed · +400 context",
    ]);
  });

  it("adds accounting details only when expanded, with context shown once", () => {
    const data = withRecap({ status: "ready", text: "Done", usage: snapshot().metrics.usage });

    const detailed = card(data, true, 120).join("\n");

    expect(detailed).toContain("3 tools · 370 processed · Context +400 (≈1.0k/10.0k, 10.0%)");
    expect(detailed).toContain("Reported cost $0.3300 · Reasoning 10 (included in output)");
    expect(detailed).toContain("Recap only: 370 tokens · $0.3300 reported (excluded above)");
    expect(detailed).toContain("Input 100 · Output 50 · Cache read 200 · Cache write 20");
    expect(detailed).toContain("2 responses · 1 tool errors · 1 compactions");
    expect(detailed).toMatch(/2\.0s wall · 0\.5s waiting · Started /u);
    expect(detailed).toContain("Models: provider/model");
    expect(detailed.match(/context/giu)).toHaveLength(1);
    expect(card(data).join("\n")).not.toContain("Reported cost");
  });

  it("names a single tool call in the singular", () => {
    const data = snapshot();
    data.metrics.toolCalls = 1;

    expect(card({ data }).at(-1)).toContain("1 tool ·");
  });

  it.each([
    { context: undefined, label: "unavailable", detail: "unavailable context" },
    {
      context: { tokens: null, contextWindow: 10000, percent: null, startTokens: 600 },
      label: "unknown",
      detail: "Context unknown (10.0k window)",
    },
    {
      context: { tokens: 500, contextWindow: 10000, percent: 5, startTokens: null },
      label: "unknown",
      detail: "Context unknown (≈500/10.0k, 5.0%)",
    },
    {
      context: { tokens: 0, contextWindow: 10000, percent: 0, startTokens: 0 },
      label: "+0",
      detail: "Context +0 (≈0/10.0k, 0.0%)",
    },
    {
      context: { tokens: 400, contextWindow: 10000, percent: 4, startTokens: 1000 },
      label: "−600",
      detail: "Context −600 (≈400/10.0k, 4.0%)",
    },
  ])(
    "renders $label run growth without confusing missing context with zero",
    ({ context, label, detail }) => {
      const data = snapshot();

      if (context === undefined) delete data.metrics.context;
      else data.metrics.context = context;

      expect(card({ data }).join("\n")).toContain(`370 processed · ${label} context`);

      const detailed = card({ data }, true).join("\n");

      expect(detailed).toContain(detail);
      expect(detailed.match(/context/giu)).toHaveLength(1);
    },
  );

  it.each([false, true])("colors context by window fullness, expanded=%s", (expanded) => {
    const data = snapshot();
    data.metrics.context = { tokens: 9000, contextWindow: 10000, percent: 90, startTokens: 8000 };
    const theme = createIdentityTheme();
    const foreground = vi.spyOn(theme, "fg");

    renderCard(data, undefined, 80, theme, expanded);

    expect(foreground).toHaveBeenCalledWith(
      "error",
      expanded ? "+1.0k (≈9.0k/10.0k, 90.0%)" : "+1.0k",
    );
  });

  it("sanitizes persisted recap text and model names", () => {
    const data = withRecap({
      status: "ready",
      text: "\u001B[31mDone\u001B[0m\u0007‮",
      usage: snapshot().metrics.usage,
    });

    data.data.metrics.models = ["provider/\u001B[31mmodel‮"];
    const rendered = renderCard(data.data, data.recap, 100, createIdentityTheme(), true).join("\n");

    expect(rendered).toContain("Done");
    expect(stripTerminalSequences(rendered)).not.toContain("\u001B");
    expect(rendered).not.toContain("‮");
  });

  it.each([0, 1, 2, 10, 40, 80, 140])("fits width %i in both modes", (width) => {
    for (const recap of [
      {
        status: "ready",
        text: "🦄 Parser ready.\nNext: test it.",
        usage: snapshot().metrics.usage,
      },
      { status: "failed", error: "failure ".repeat(125) },
    ] as const) {
      for (const expanded of [false, true]) {
        const lines = renderCard(snapshot(), recap, width, createIdentityTheme(), expanded);

        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);

        if (width === 0) expect(lines).toEqual([]);
      }
    }
  });
});

describe("live row", () => {
  it("shows running statistics on one row in whole seconds, even while paused", () => {
    const theme = createIdentityTheme();

    expect(renderLive(running(), 100, theme)).toEqual([
      "  1s active · 3 tools · 370 processed · +400 context",
    ]);
    expect(renderLive(running(true), 100, theme)[0]).toContain("1s active");

    const narrow = renderLive(running(), 20, theme);

    expect(narrow).toHaveLength(1);
    expect(visibleWidth(narrow[0] ?? "")).toBeLessThanOrEqual(20);
    expect(stripTerminalSequences(narrow[0] ?? "")).toMatch(/…$/u);
  });

  it("marks only numeric fields before styling and layout", () => {
    const theme = createIdentityTheme();
    const foreground = vi.spyOn(theme, "fg");
    const numeric = vi.fn((_id: string, text: string) => text.replace(/\d/gu, "X"));

    expect(renderLive(running(), 100, theme, numeric)).toEqual([
      "  Xs active · X tools · XXX processed · +XXX context",
    ]);
    expect(numeric.mock.calls.map(([id]) => id).sort()).toEqual([
      "active",
      "context",
      "processed",
      "tools",
    ]);
    expect(foreground).toHaveBeenCalledWith("text", "XXX");
  });
});
