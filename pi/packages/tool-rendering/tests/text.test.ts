import { describe, expect, it } from "vite-plus/test";

import { displayText, inlineText, jsonText, safeText } from "../text.js";

describe("safe terminal text", () => {
  it("retains native JSON projections and failures for arbitrary JavaScript values", () => {
    expect(
      jsonText({
        omitted: undefined,
        numbers: [Number.NaN, Infinity],
        date: new Date(0),
      })
    ).toBe('{"numbers":[null,null],"date":"1970-01-01T00:00:00.000Z"}');
    expect(jsonText({ toJSON: () => "\u202Eprojected" })).toBe(
      '"\\u202eprojected"'
    );

    for (const value of [undefined, () => 1, Symbol("unsupported"), 1n]) {
      expect(() => jsonText(value)).toThrow(TypeError);
    }

    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => jsonText(cycle)).toThrow(
      "Converting circular structure to JSON"
    );
  });

  it("escapes every unsafe display character in JSON without changing values", () => {
    const controls = `${Array.from({ length: 160 }, (_, i) =>
      String.fromCodePoint(i)
    ).join(
      ""
    )}\u061C\u200E\u200F\u2028\u2029\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069`;

    const value = {
      [controls]: [controls, "日本語🙂", 'quote"slash\\', "\t\r\n"],
    };

    const serialized = jsonText(value);
    expect(JSON.parse(serialized)).toStrictEqual(value);
    expect(safeText(serialized)).toBe(serialized);

    for (const character of [
      "\u061C",
      "\u200E",
      "\u200F",
      "\u2028",
      "\u2029",
    ]) {
      expect(serialized).not.toContain(character);
    }

    expect(jsonText("\u061C\u200E\u200F")).toBe('"\\u061c\\u200e\\u200f"');
  });

  it("strips ANSI, control bytes and directional overrides but preserves log whitespace", () => {
    expect(safeText("\u001B[31mred\u001B[0m\u0000\u0007\r\u202E\n\t")).toBe(
      "red\n\t"
    );
    expect(
      safeText("a\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007b")
    ).toBe("alinkb");
    expect(safeText("a\u0085\u2066b\u2069")).toBe("ab");
    expect(safeText("a\u061C\u200E\u200F\u202Ab\u202C")).toBe("ab");
  });

  it("normalizes display whitespace without interpreting source text", () => {
    const source = "\t- removed\n+ added\n**literal** 中文";
    expect(displayText(source)).toBe("   - removed\n+ added\n**literal** 中文");
    expect(inlineText(source)).toBe("   - removed + added **literal** 中文");
    expect(displayText(displayText(source))).toBe(displayText(source));
    expect(displayText("trailing  \n")).toBe("trailing  \n");
  });
});
