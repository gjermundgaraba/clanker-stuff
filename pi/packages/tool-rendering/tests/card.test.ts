import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { createIdentityTheme } from "../../../tests/harness/tui.js";
import { card, entryPad } from "../card.js";

const plain = createIdentityTheme();

const view = { expanded: false, keyHint: (_id: string, text: string) => text };

const strip = (rows: readonly string[]) =>
  rows.map((row) => stripVTControlCharacters(row).trimEnd());

describe("card", () => {
  beforeAll(() => {
    initTheme("dark");
  });

  it("puts the aside at the right edge when it fits, and drops it when it does not", () => {
    const parts = { heading: "✉ message from b", aside: "m_1234" };

    const wide = strip(card(plain, view, parts).render(40));
    const narrow = strip(card(plain, view, parts).render(18));

    expect(wide[0]).toMatch(/^✉ message from b +m_1234$/u);
    expect(visibleWidth(wide[0] ?? "")).toBe(40);
    expect(narrow[0]).toBe("✉ message from b");
  });

  it("indents rows and bounds the body until expanded", () => {
    const parts = {
      heading: "⏳ waiting on job",
      lines: ["every 15s"],
      body: ["one", "", "two", "", "three", "", "four"].join("\n"),
    };

    const collapsed = strip(card(plain, view, parts, { limit: 3 }).render(40));

    const expanded = strip(
      card(plain, { ...view, expanded: true }, parts, { limit: 3 }).render(40)
    );

    expect(collapsed[1]).toBe("  every 15s");
    expect(collapsed.at(-1)).toMatch(/more lines/u);
    expect(expanded.some((row) => row.includes("four"))).toBe(true);
    expect(collapsed.some((row) => row.includes("four"))).toBe(false);
  });

  it("pads entries like Pi pads its own rows", () => {
    expect([
      entryPad({ outputPad: 0 }),
      entryPad({ outputPad: 1 }),
      entryPad({}),
    ]).toStrictEqual([0, 1, 1]);
  });
});
