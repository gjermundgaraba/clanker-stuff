import { describe, expect, it } from "vite-plus/test";

import { childContextSummary, CHILD_CONTEXT_TYPE, withChildContext } from "../../v2/context.js";

const agent = (path: string, resident = false) => ({ path, resident });

describe("V2 child context", () => {
  it("lists direct registered children, resident first and alphabetical within each group", () => {
    expect(
      childContextSummary("/root", [
        agent("/root/a"),
        agent("/root/z", true),
        agent("/root/b", true),
        agent("/root/a/grandchild", true),
        agent("/root"),
        agent("/root/c"),
      ]),
    ).toBe(
      '  <subagents>\n    <agent name="/root/b" />\n    <agent name="/root/z" />\n    <agent name="/root/a" />\n    <agent name="/root/c" />\n  </subagents>\n',
    );
    expect(
      childContextSummary("/root/a", [
        agent("/root/a"),
        agent("/root/a/grandchild"),
        agent("/root/b"),
      ]),
    ).toBe('  <subagents>\n    <agent name="/root/a/grandchild" />\n  </subagents>\n');
  });

  it("limits output to eight children and skips entries that exceed the native UTF-8 budget", () => {
    const many = Array.from({ length: 12 }, (_, index) => agent(`/root/a${index}`));
    expect(childContextSummary("/root", many).match(/<agent /gu)).toHaveLength(8);
    const parent = `/root/${"a".repeat(440)}`;

    const bounded = childContextSummary(parent, [
      agent(`${parent}/a`),
      agent(`${parent}/b`),
      agent(`${parent}/c`),
    ]);

    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(1024);
    expect(bounded.match(/<agent /gu)).toHaveLength(2);
    expect(
      childContextSummary("/root", [agent(`/root/${"a".repeat(1024)}`), agent("/root/z")]),
    ).toContain("/root/z");
    expect(childContextSummary("/root", [])).toBe("");
  });

  it("keeps an unchanged inventory prefix stable as conversation history grows", () => {
    const history = [{ role: "user" as const, content: "work", timestamp: 1 }];
    const summary = childContextSummary("/root", [agent("/root/a")]);
    const first = withChildContext(history, summary).messages;

    const next = withChildContext(
      [...history, { role: "user" as const, content: "continue", timestamp: 2 }],
      summary,
    ).messages;

    expect(next.slice(0, first.length)).toStrictEqual(first);
  });

  it("replaces the ephemeral prefix without mutating history and removes empty inventories", () => {
    const original = [{ role: "user" as const, content: "work", timestamp: 1 }];
    const first = withChildContext(original, childContextSummary("/root", [agent("/root/a")]));

    const second = withChildContext(
      first.messages,
      childContextSummary("/root", [agent("/root/b")]),
    );

    expect(original).toHaveLength(1);
    expect(second.messages).toHaveLength(2);
    expect(second.messages[0]).toMatchObject({ customType: CHILD_CONTEXT_TYPE, display: false });
    expect(JSON.stringify(second.messages)).not.toContain("/root/a");
    expect(withChildContext(second.messages, "").messages).toStrictEqual(original);
  });
});
