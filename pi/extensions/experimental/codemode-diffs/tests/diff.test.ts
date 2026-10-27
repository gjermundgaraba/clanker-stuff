import { stripVTControlCharacters } from "node:util";

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import { renderHighlightedDiff } from "../diff.js";
import { highlightDiff } from "../highlight.js";

const setup = () => {
  const theme = createIdentityTheme();
  const styled: Array<[ThemeColor, string]> = [];
  const inverse: string[] = [];
  theme.fg = (role, text) => {
    styled.push([role, text]);

    return text;
  };

  theme.inverse = (text) => {
    inverse.push(text);

    return text;
  };

  return { theme, styled, inverse };
};

describe("syntax-colored diff rendering", () => {
  it("uses the active Pi syntax roles and inverse-highlights only changed words", async () => {
    const before = 'const message = "old";';
    const after = 'const message = "new";';
    const diff = `-1 ${before}\n+1 ${after}`;
    const syntax = await highlightDiff("source.ts", diff, before, after);
    const { theme, styled, inverse } = setup();

    const rendered = stripVTControlCharacters(
      renderHighlightedDiff(diff, syntax, theme)
    );

    expect(rendered).toBe(diff);
    expect(styled).toContainEqual(["syntaxKeyword", "const "]);
    expect(styled).toContainEqual(["syntaxVariable", "message "]);
    expect(styled).toContainEqual(["syntaxString", "new"]);
    expect(inverse).toStrictEqual(["old", "new"]);

    const changedTheme = setup();
    renderHighlightedDiff(diff, syntax, changedTheme.theme);
    expect(changedTheme.styled).toStrictEqual(styled);
  });

  it("does not apply single-line word emphasis to multiline replacements", async () => {
    const before = "let a = 1;\nlet b = 2;";
    const after = "let c = 3;\nlet d = 4;";
    const diff = "-1 let a = 1;\n-2 let b = 2;\n+1 let c = 3;\n+2 let d = 4;";
    const syntax = await highlightDiff("source.ts", diff, before, after);
    const { theme, inverse } = setup();
    expect(
      stripVTControlCharacters(renderHighlightedDiff(diff, syntax, theme))
    ).toBe(diff);
    expect(inverse).toStrictEqual([]);
  });

  it.each([
    undefined,
    [[1, "keyword"]],
    [[[999, "keyword"]]],
    [[[1, "unknown"]]],
    [[]],
    [
      [
        [1, "keyword"],
        [1, "string"],
      ],
    ],
  ])(
    "falls back without losing code when saved syntax is absent or malformed: %j",
    (syntax) => {
      const { theme } = setup();
      const diff = "+1 const x = 1;";
      expect(
        stripVTControlCharacters(renderHighlightedDiff(diff, syntax, theme))
      ).toBe(diff);
    }
  );

  it("sanitizes source slices after offset projection and normalizes tabs", () => {
    const { theme } = setup();
    const text = '\t"😀\u001B[2J\u202E"';

    const result = renderHighlightedDiff(
      `+1 ${text}`,
      [[[text.length, "string"]]],
      theme
    );

    expect(stripVTControlCharacters(result)).toBe('+1    "😀"');
    expect(result).not.toContain("\u001B[2J");
    expect(result).not.toContain("\u202E");
  });
});
