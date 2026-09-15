import { describe, expect, it } from "vite-plus/test";

import { buildTree, filterTree, flattenTree, followSelection } from "../tree.js";
import { fixturePart, fixtureSnapshot } from "./fixtures/snapshot.js";

const tree = buildTree({
  ...fixtureSnapshot(),
  tools: [fixturePart("read", "read file", 3)],
  messages: [fixturePart("1. user", "hello world", 3)],
});

describe("tree", () => {
  it("groups definitions and messages without duplicating the system prompt", () => {
    expect(tree.map((node) => node.id)).toEqual(["system", "tools", "messages"]);
    expect(flattenTree(tree, new Set()).map((row) => row.node.id)).toEqual([
      "system",
      "tools",
      "messages",
    ]);
    expect(flattenTree(tree, new Set(["tools"])).map((row) => row.node.id)).toEqual([
      "system",
      "tools",
      "tools-0",
      "messages",
    ]);
  });
  it("matches bodies and keeps children when the group itself matches", () => {
    expect(filterTree(tree, "hello").map((node) => node.id)).toEqual(["messages"]);
    expect(filterTree(tree, "hello")[0].children[0].body).toBe("hello world");
    expect(filterTree(tree, "Active tools")[0].children).toEqual(tree[1].children);
    expect(filterTree(tree, "nothing matches")).toEqual([]);
  });
  it.each([
    [0, 0, 5, 20, 0],
    [6, 0, 5, 20, 2],
    [1, 4, 5, 20, 1],
    [19, 18, 10, 20, 10],
    [0, 5, 20, 3, 0],
    [0, 4, 0, 0, 0],
  ])(
    "follows selection %s from scroll %s in %s rows",
    (selected, scroll, viewport, total, expected) => {
      expect(followSelection(selected, scroll, viewport, total)).toBe(expected);
    },
  );
});
