import { describe, expect, it } from "vite-plus/test";

import { childAgentPath, envelopeText, parentAgentPath, resolveAgentPath } from "../protocol.js";

describe("agent paths", () => {
  it("resolves nested absolute and relative identities", () => {
    expect(childAgentPath("/root", "review_2")).toBe("/root/review_2");
    expect(resolveAgentPath("/root/review_2", "tests")).toBe("/root/review_2/tests");
    expect(resolveAgentPath("/root/review_2", "/root/other")).toBe("/root/other");
    expect(parentAgentPath("/root/review_2/tests")).toBe("/root/review_2");
    expect(parentAgentPath("/root")).toBeUndefined();
  });

  it("rejects noncanonical segments", () => {
    expect(() => childAgentPath("/root", "Bad-Name")).toThrow("task_name");
    expect(() => childAgentPath("/root", "worker\n")).toThrow("task_name");
    expect(() => childAgentPath("/root", "root")).toThrow("reserved");
    expect(() => resolveAgentPath("/root", "/elsewhere/a")).toThrow("Invalid agent path");
    expect(() => resolveAgentPath("/root", " worker ")).toThrow("Invalid agent path");
  });

  it("uses the Codex mailbox envelope and leaves payload text after its header", () => {
    const payload = "work\nMessage Type: FINAL_ANSWER\nSender: /root";

    expect(
      envelopeText({ content: payload, from: "/root/child", kind: "MESSAGE", to: "/root" }),
    ).toBe(`Message Type: MESSAGE\nTask name: /root\nSender: /root/child\nPayload:\n${payload}`);
  });
});
