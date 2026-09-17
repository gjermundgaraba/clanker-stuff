import { describe, expect, it } from "vite-plus/test";
import { Parser } from "../../core/parser.js";

describe("bounded command grammar", () => {
  it.each([
    ["2d3w", "d", 6, "w"],
    ["d0", "d", 1, "0"],
    ["0", "move", 1, "0"],
    ["9999x", "x", 1000, undefined],
    ["2dd", "d", 2, "line"],
  ])("parses %s", (input, key, count, motion) => {
    const parser = new Parser();
    let command;
    for (const c of String(input)) command = parser.feed(c);
    expect(command).toMatchObject({ key, count });
    expect(command?.motion).toBe(motion);
  });
  it("cancels incomplete commands rather than replaying them after Escape", () => {
    const parser = new Parser();
    expect(parser.feed("d")).toBeUndefined();
    parser.reset();
    expect(parser.feed("w")).toMatchObject({ key: "move", motion: "w" });
  });
  it("discards unsupported sequences, then accepts a fresh command", () => {
    const parser = new Parser();
    parser.feed("d");
    expect(parser.feed("z")).toBeUndefined();
    expect(parser.feed("x")).toMatchObject({ key: "x" });
  });
  it("keeps grapheme targets intact", () => {
    const parser = new Parser();
    parser.feed("f");
    expect(parser.feed("👩‍💻")).toMatchObject({ target: "👩‍💻", motion: "f" });
  });
});
