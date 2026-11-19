import assert from "node:assert/strict";

import { describe, expect, it } from "vite-plus/test";

import {
  assistantEntry,
  exited,
  setup,
  userEntry,
  waitForMessages,
} from "../helpers.js";

describe("plannotator-last", () => {
  it("passes the last assistant message through stdin with the given flags", async () => {
    const entry = assistantEntry("assistant", null, "Original answer");
    const { ctx, host, pending } = setup([entry], entry.id);
    await host.runCommand("plannotator-last", "--gate", ctx);
    expect(pending[0]).toMatchObject({
      args: ["annotate-last", "--stdin", "--json", "--gate"],
      options: { cwd: "/work/project", stdin: "Original answer" },
    });
  });

  it("skips blank responses and other branches when finding assistant text", async () => {
    const assistant = assistantEntry("assistant", null, "  Original answer\n");
    const user = userEntry("user", assistant.id, "Another request");
    const blank = assistantEntry("blank", user.id, " \n ");

    const otherBranch = assistantEntry(
      "other-branch",
      assistant.id,
      "Unrelated answer"
    );

    const { ctx, host, pending } = setup(
      [assistant, user, blank, otherBranch],
      blank.id
    );

    await host.runCommand("plannotator-last", "", ctx);

    expect(pending[0]?.options.stdin).toBe("Original answer");
  });

  it("does not start last-message annotation without an assistant message", async () => {
    const entry = userEntry("user", "root", "hello");
    const { ctx, host, pending } = setup([entry], entry.id);
    await host.runCommand("plannotator-last", "", ctx);
    expect(pending).toHaveLength(0);
    expect(host.getNotifications().at(-1)).toStrictEqual({
      message: "No assistant message found in session.",
      type: "error",
    });
  });

  it("anchors feedback to the annotated response, which later turns may follow", async () => {
    const assistant = assistantEntry("assistant", null, "Original answer");
    const user = userEntry("later-user", assistant.id, "Another request");
    const { ctx, host, pending } = setup([assistant, user], assistant.id);
    await host.runCommand("plannotator-last", "", ctx);
    host.setLeafId(user.id);

    const [child] = pending;
    assert.ok(child);
    child.resolve(
      exited(JSON.stringify({ decision: "annotated", feedback: "Clarify it." }))
    );
    await waitForMessages(host, 1);
    const content = host.getSentUserMessages()[0]?.content;
    assert.equal(typeof content, "string");
    expect(content).toContain("> Original answer");
    expect(content).toContain("User feedback:\nClarify it.");
  });
});
