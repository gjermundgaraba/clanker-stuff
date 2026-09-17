import { describe, expect, it } from "vite-plus/test";
import { Insertion, applyDelta, Transactions } from "../transactions.js";
import type { View } from "../core/document.js";

const view = (text: string, cursor: number): View => ({ text, cursor, atoms: [] });

it("preserves redo through cursor-only changes", () => {
  const history = new Transactions();
  const before = view("one", 0);
  const after = view("two", 0);
  history.commit(before, after);
  expect(history.undo(after)).toBe(before);
  history.commit(before, view("one", 2));
  expect(history.redo(before)).toBe(after);
});

it("records payload changes even when the collapsed marker is unchanged", () => {
  const history = new Transactions();
  const before = { ...view("[paste #1]", 0), atoms: [{ start: 0, end: 10, content: "old" }] };
  const after = { ...before, atoms: [{ start: 0, end: 10, content: "new" }] };
  history.commit(before, after);
  expect(history.undo(after)).toBe(before);
  expect(history.redo(before)).toBe(after);
});

describe("insertion change accumulation", () => {
  it("anchors identical inserted characters at the actual cursor", () => {
    const before = view("aaa bbb", 0);
    const after = view("aaaa bbb", 1);
    const insertion = new Insertion(before);
    insertion.record(before, after);
    expect(insertion.delta(after)).toEqual({ offset: 0, remove: 0, text: "a" });
  });

  it("composes edits on both sides of the first change into one replacement", () => {
    const original = view("abcd", 2);
    const insertion = new Insertion(original);
    insertion.record(original, view("abXcd", 3));
    insertion.record(view("abXcd", 0), view("YabXcd", 1));
    insertion.record(view("YabXcd", 5), view("YabXcZd", 6));
    const after = view("YabXcZd", 6);
    const delta = insertion.delta(after);
    expect(delta).toEqual({ offset: -2, remove: 3, text: "YabXcZ" });
    const edit = applyDelta(original, delta);
    expect(original.text.slice(0, edit.start) + edit.text + original.text.slice(edit.end)).toBe(
      after.text,
    );
  });

  it("cancels insertion followed by backspace without deleting neighboring equal text", () => {
    const original = view("aaa", 1);
    const insertion = new Insertion(original);
    insertion.record(original, view("aaaa", 2));
    insertion.record(view("aaaa", 2), original);
    expect(insertion.delta(original)).toEqual({ offset: 0, remove: 0, text: "" });
  });

  it("retains deletion location among repeated characters", () => {
    const original = view("aaa", 1);
    const after = view("aa", 0);
    const insertion = new Insertion(original);
    insertion.record(original, after);
    expect(insertion.delta(after)).toEqual({ offset: -1, remove: 1, text: "" });
  });
});

it("cancels net-identical edits away from the insertion origin", () => {
  const original = view("aaa", 0);
  const insertion = new Insertion(original);
  insertion.record(view("aaa", 2), view("aa", 1));
  insertion.record(view("aa", 1), view("aaa", 2));
  expect(insertion.delta(view("aaa", 2))).toEqual({ offset: 0, remove: 0, text: "" });
});
