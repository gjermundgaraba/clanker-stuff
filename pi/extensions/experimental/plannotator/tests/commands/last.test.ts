import { describe, expect, it, vi } from "vite-plus/test";

import {
  assistantEntry,
  exited,
  expectString,
  setup,
  userEntry,
  waitForMessages,
} from "../helpers.js";

vi.mock(import("../../command-runtime.js"), { spy: true });

describe("plannotator-last", () => {
  it("passes the last assistant message through controlled stdin flags", async () => {
    const entry = assistantEntry("assistant", null, "Original answer");
    const { ctx, host, pending } = setup([entry], entry.id);
    await host.runCommand("plannotator-last", "--gate --stdin --json --stdin", ctx);
    expect(pending[0]).toMatchObject({
      args: ["annotate-last", "--stdin", "--json", "--gate"],
      options: { cwd: "/work/project", stdin: "Original answer" },
    });
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

  it("anchors last-message feedback after the active branch moves", async () => {
    const assistant = assistantEntry("assistant", null, "Original answer");
    const user = userEntry("later-user", assistant.id, "Another request");
    const { ctx, host, pending } = setup([assistant, user], assistant.id);
    await host.runCommand("plannotator-last", "", ctx);
    host.setLeafId(user.id);

    pending[0].resolve(exited(JSON.stringify({ decision: "annotated", feedback: "Clarify it." })));
    await waitForMessages(host, 1);
    const content = expectString(host.getSentUserMessages()[0]?.content);
    expect(content).toContain("> Original answer");
    expect(content).toContain("User feedback:\nClarify it.");
  });
});
