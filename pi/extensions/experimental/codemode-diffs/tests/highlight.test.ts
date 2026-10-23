import { describe, expect, it } from "vite-plus/test";

import { highlightDiff, SyntaxSchema } from "../highlight.js";
import { Value } from "typebox/value";

describe("Highlights diff projection", () => {
  it("preserves multiline lexer state beyond the displayed hunk and separates the two source versions", async () => {
    const padding = Array.from({ length: 12 }, () => "comment body").join("\n");
    const oldLine = "const old = 1;";
    const newLine = "const next = 2;";
    const before = `/*\n${padding}\n${oldLine}\n*/\n`;
    const after = `//\n${padding}\n${newLine}\n*/\n`;

    const syntax = await highlightDiff(
      "source.ts",
      `-14 ${oldLine}\n+14 ${newLine}`,
      before,
      after,
    );

    expect(Value.Check(SyntaxSchema, syntax)).toBe(true);
    expect(syntax?.[0]).toEqual([[oldLine.length, "comment"]]);
    expect(syntax?.[1]?.map((span) => span[1])).toEqual([
      "keyword",
      "variable",
      "operator",
      "number",
      "punctuation",
    ]);
    expect(JSON.stringify(syntax)).not.toContain("comment body");
  });

  it("matches native BOM/CRLF normalization and counts UTF-16 rather than UTF-8 bytes", async () => {
    const before = 'const x = "😀";';
    const after = 'const x = "界";';

    const syntax = await highlightDiff(
      "source.ts",
      `-1 ${before}\n+1 ${after}`,
      `\uFEFF${before}\r\n`,
      `\uFEFF${after}\r\n`,
    );

    expect(syntax?.[0]?.at(-1)?.[0]).toBe(before.length);
    expect(syntax?.[1]?.at(-1)?.[0]).toBe(after.length);
    expect(syntax?.[0]).toContainEqual([before.length - 1, "string"]);
  });

  it("projects old-numbered context after insertions and leaves ellipses or unmatched rows unstyled", async () => {
    const before = "const first = 1;\nconst second = 2;\n";
    const after = "const extra = 0;\n" + before;

    const syntax = await highlightDiff(
      "source.ts",
      "+1 const extra = 0;\n 1 const first = 1;\n   ...\n 2 const second = 2;\n+99 mismatch",
      before,
      after,
    );

    expect(syntax?.[1]?.[0]?.[1]).toBe("keyword");
    expect(syntax?.[2]).toBeNull();
    expect(syntax?.[3]?.[0]?.[1]).toBe("keyword");
    expect(syntax?.[4]).toBeNull();
  });

  it("uses the TSX lexer for JSX syntax, including inside expressions", async () => {
    const line = 'const view = <Widget title="hello">{value}</Widget>;';
    const syntax = await highlightDiff("view.tsx", `+1 ${line}`, "", line);
    const spans = syntax?.[0];
    expect(spans).not.toBeNull();
    expect(spans).toContainEqual([line.indexOf('"hello"') + '"hello"'.length, "string"]);
    expect(spans?.at(-1)?.[0]).toBe(line.length);
  });

  it("returns no highlighting for unknown languages", async () => {
    expect(await highlightDiff("notes.txt", "+1 plain", "", "plain")).toBeUndefined();
  });
});
