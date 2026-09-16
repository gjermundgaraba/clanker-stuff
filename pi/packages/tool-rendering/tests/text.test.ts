import { describe, expect, it } from "vite-plus/test";
import { displayText, inlineText, jsonText, safeText } from "../text.js";

describe("safe terminal text", () => {
  it("escapes every unsafe display character in JSON without changing values", () => {
    const controls =
      Array.from({ length: 160 }, (_, i) => String.fromCharCode(i)).join("") +
      "\u061c\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    const value = { [controls]: [controls, "日本語🙂", 'quote"slash\\', "\t\r\n"] };
    const serialized = jsonText(value);
    expect(JSON.parse(serialized)).toEqual(value);
    expect(safeText(serialized)).toBe(serialized);
    for (const character of ["\u061c", "\u200e", "\u200f", "\u2028", "\u2029"])
      expect(serialized).not.toContain(character);
    expect(jsonText("\u061c\u200e\u200f")).toBe('"\\u061c\\u200e\\u200f"');
  });
  it("strips ANSI, control bytes and directional overrides but preserves log whitespace", () => {
    expect(safeText("\x1b[31mred\x1b[0m\x00\x07\r\u202e\n\t")).toBe("red\n\t");
    expect(safeText("a\x1b]8;;https://example.com\x07link\x1b]8;;\x07b")).toBe("alinkb");
    expect(safeText("a\u0085\u2066b\u2069")).toBe("ab");
    expect(safeText("a\u061c\u200e\u200f\u202ab\u202c")).toBe("ab");
  });
  it("normalizes display whitespace without interpreting source text", () => {
    const source = "\t- removed\n+ added\n**literal** 中文";
    expect(displayText(source)).toBe("   - removed\n+ added\n**literal** 中文");
    expect(inlineText(source)).toBe("   - removed + added **literal** 中文");
    expect(displayText(displayText(source))).toBe(displayText(source));
    expect(displayText("trailing  \n")).toBe("trailing  \n");
  });
});
