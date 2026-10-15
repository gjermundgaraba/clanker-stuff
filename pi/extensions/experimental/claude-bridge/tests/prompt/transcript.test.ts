// pi replays system-message section patches in replay order, while prompt capture keys
// come from pi's canonical section builder (preamble, tools, rules, docs, addendum,
// project_context, skills, cwd, then custom sections). A deleted and re-added section,
// or one first appearing mid-session, must be ranked back into its canonical slot so the
// replayed prompt stays byte-identical to the recorded key.

import type { Message, SystemMessage, Tool, UserMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import { toBridgeContext } from "../../prompt/transcript.js";

import { transcript } from "../helpers.js";

const system = (
  patch: Omit<SystemMessage, "role" | "timestamp" | "content"> & {
    content?: SystemMessage["content"];
  },
): SystemMessage => ({ role: "system", content: "", timestamp: 0, ...patch });

const user = (text: string): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 0,
});

const tool = (name: string): Tool => ({ name, description: "", parameters: Type.Object({}) });

const replayed = (messages: Message[]) => toBridgeContext(transcript({ messages })).systemPrompt;

describe("toBridgeContext section order", () => {
  it("re-emits a deleted and re-added section in its canonical slot", () => {
    // Replay order after the re-add: preamble, tools, rules, docs, cwd, skills.
    const prompt = replayed([
      system({ toolsAdded: [tool("read")] }),
      system({ sections: { preamble: "P", tools: "T", rules: "R", docs: "D", cwd: "/w" } }),
      system({ sections: { skills: null } }),
      system({ sections: { skills: "S", cwd: "/w" } }),
      user("go"),
    ]);

    expect(prompt).toBe(["P", "T", "R", "D", "S", "/w"].join("\n\n"));
  });

  it("ranks a section pi does not know after cwd", () => {
    const prompt = replayed([
      system({
        sections: { preamble: "P", tools: "T", rules: "R", docs: "D", environment: "E", cwd: "/w" },
      }),
      user("go"),
    ]);

    expect(prompt).toBe(["P", "T", "R", "D", "/w", "E"].join("\n\n"));
  });

  // pi's MCP extension adds `mcp_servers` once its servers connect, here beside an
  // addendum the first render lacked.
  it("puts a late custom section after cwd and a late built-in in its slot", () => {
    const prompt = replayed([
      system({
        sections: {
          preamble: "P",
          tools: "T",
          rules: "R",
          docs: "D",
          project_context: "C",
          skills: "S",
          cwd: "/w",
        },
      }),
      system({ sections: { addendum: "A", mcp_servers: "M" } }),
      user("go"),
    ]);

    expect(prompt).toBe(["P", "T", "R", "D", "A", "C", "S", "/w", "M"].join("\n\n"));
  });

  it("keeps custom sections in their replayed order", () => {
    const prompt = replayed([
      system({ sections: { preamble: "P", zeta: "Z", cwd: "/w", alpha: "X" } }),
      user("go"),
    ]);

    expect(prompt).toBe(["P", "/w", "Z", "X"].join("\n\n"));
  });

  it("renders text-array content ahead of the sections", () => {
    const prompt = replayed([
      system({
        content: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
      }),
      system({ sections: { cwd: "/w" } }),
      user("go"),
    ]);

    expect(prompt).toBe(["A\nB", "/w"].join("\n\n"));
  });
});

describe("toBridgeContext", () => {
  it("reconstructs the tool set through removals and re-adds", () => {
    const context = toBridgeContext(
      transcript({
        messages: [
          system({ toolsAdded: [tool("read"), tool("grep")] }),
          system({ toolsRemoved: [{ name: "read" }] }),
          system({ toolsAdded: [tool("read")] }),
          user("go"),
        ],
      }),
    );

    expect(context.tools?.map(({ name }) => name)).toEqual(["grep", "read"]);
  });

  it("drops system messages from history and an empty tool set", () => {
    const go = user("go");

    const context = toBridgeContext(
      transcript({
        messages: [
          system({ content: "P", toolsAdded: [tool("read")] }),
          system({ toolsRemoved: [{ name: "read" }] }),
          go,
        ],
      }),
    );

    expect(context).toEqual({ systemPrompt: "P", messages: [go] });
    expect(context).not.toHaveProperty("tools");
  });

  it("passes a transcript without system messages through as history alone", () => {
    const messages = [user("go")];
    const context = toBridgeContext(transcript({ messages }));

    expect(context.messages).toBe(messages);
    expect(context).toEqual({ messages });
  });
});
