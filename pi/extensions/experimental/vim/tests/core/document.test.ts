import { expect, it } from "vite-plus/test";
import { units, normalCursor, next, previous } from "../../core/document.js";

it("treats extended graphemes and owned paste markers as indivisible units", () => {
  const text = "👩‍💻é[paste #1 +50 lines]x";

  const view = {
    text,
    cursor: 0,
    atoms: [{ start: 7, end: text.length - 1, content: "hidden payload" }],
  };

  expect(units(view).map((u) => u.text)).toEqual(["👩‍💻", "é", "[paste #1 +50 lines]", "x"]);
  expect(next(view, 0)).toBe(5);
  expect(previous(view, 7)).toBe(5);
  expect(normalCursor(view, 10)).toBe(7);
});

it("allows the sole cursor position on empty lines", () => {
  const view = { text: "a\n\nb", cursor: 0, atoms: [] };
  expect(normalCursor(view, 2)).toBe(2);
  expect(normalCursor(view, 1)).toBe(0);
});
