import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

// pi does not export its prompt builder; these tests run against the renderer pi runs, so
// a pi upgrade that moves its own text into a forwarded section fails here.
import { buildSystemPromptState } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { forwardedPrompt, PI_PREAMBLE, systemText, toBridgeContext } from "../prompt.js";
import { transcript } from "./helpers.js";

/** The system message pi sends providers for these options. */
function piSystem(options: Omit<BuildSystemPromptOptions, "cwd">): SystemMessage {
  const { content, sections } = buildSystemPromptState({ ...options, cwd: "/repo" });

  return { role: "system", content, timestamp: 0, ...(sections === undefined ? {} : { sections }) };
}

const skill = {
  name: "browser",
  description: "Drive a browser",
  filePath: "/skills/browser/SKILL.md",
  baseDir: "/skills/browser",
  sourceInfo: createSyntheticSourceInfo("/skills/browser/SKILL.md", { source: "test" }),
  disableModelInvocation: false,
};

describe(forwardedPrompt, () => {
  it("forwards the user's sections from pi's default prompt and none of pi's own", () => {
    const system = piSystem({
      selectedTools: ["read", "bash"],
      toolGuidelines: { bash: ["Prefer rg over grep"] },
      contextFiles: [{ path: "/repo/AGENTS.md", content: "Use tabs." }],
      skills: [skill],
      appendSystemPrompt: "Answer in English.",
      sections: { mcp_servers: "<mcp_servers>\nnone\n</mcp_servers>" },
    });

    const forwarded = forwardedPrompt(system) ?? "";

    expect(forwarded).toContain("Use tabs.");
    expect(forwarded).toContain("/skills/browser/SKILL.md");
    expect(forwarded).toContain("Answer in English.");
    expect(forwarded).toContain("<mcp_servers>");

    expect(forwarded).not.toContain(PI_PREAMBLE);
    expect(forwarded).not.toContain("<tools>");
    // Rules carry pi's own bullets; tool guidelines travel in MCP descriptions instead.
    expect(forwarded).not.toContain("Prefer rg over grep");
    expect(forwarded).not.toContain("Be concise in your responses");
    expect(forwarded).not.toContain("docs/custom-provider.md");
    expect(forwarded).not.toContain("<cwd>");
  });

  it("keeps pi's section order", () => {
    const forwarded =
      forwardedPrompt(
        piSystem({
          contextFiles: [{ path: "/repo/AGENTS.md", content: "Use tabs." }],
          skills: [skill],
          appendSystemPrompt: "Answer in English.",
        }),
      ) ?? "";

    const order = ["Answer in English.", "Use tabs.", "/skills/browser/SKILL.md"].map((text) =>
      forwarded.indexOf(text),
    );

    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it("forwards a custom prompt, which replaces pi's own text", () => {
    expect(forwardedPrompt(piSystem({ customPrompt: "You review code." }))).toBe(
      "You review code.",
    );
  });

  it("forwards a replaced prompt whole", () => {
    expect(forwardedPrompt(piSystem({ forceSystemPrompt: "Only answer yes or no." }))).toBe(
      "Only answer yes or no.",
    );
  });

  it("forwards nothing for a default prompt with nothing of the user's in it", () => {
    expect(forwardedPrompt(piSystem({}))).toBeUndefined();
    expect(forwardedPrompt(undefined)).toBeUndefined();
  });
});

describe("the third-party gate", () => {
  it("refuses pi's preamble at the start of a line and names where it was", () => {
    const system = piSystem({ appendSystemPrompt: `Context:\n${PI_PREAMBLE}, a harness.` });

    expect(() => forwardedPrompt(system)).toThrow(/pi's preamble .* in the appended instructions/);
  });

  it("refuses pi's whole prompt sent as a replacement", () => {
    const harness = buildSystemPromptState({ cwd: "/repo" });
    const rendered = Object.values(harness.sections ?? {}).join("\n\n");

    expect(() => forwardedPrompt(piSystem({ forceSystemPrompt: rendered }))).toThrow(
      /refusing to send this prompt/,
    );
  });

  // Either file alone passes, so the pair split across two files still trips the gate.
  it("refuses the doc-path pair in context files and names the files", () => {
    const system = piSystem({
      contextFiles: [
        { path: "/AGENTS.md", content: "see docs/custom-provider.md" },
        { path: "/unrelated/AGENTS.md", content: "nothing to see" },
        { path: "/repo/AGENTS.md", content: "and docs/packages.md" },
      ],
    });

    expect(() => forwardedPrompt(system)).toThrow(
      "docs/custom-provider.md and docs/packages.md in the project context block (from /AGENTS.md, /repo/AGENTS.md)",
    );
  });

  it.each(["docs/custom-provider.md", "docs/packages.md"])("allows %s on its own", (path) => {
    expect(forwardedPrompt(piSystem({ customPrompt: `see ${path}` }))).toBe(`see ${path}`);
  });

  it("allows a mid-line mention of pi's preamble", () => {
    const custom = `note: ${PI_PREAMBLE}, allegedly`;

    expect(forwardedPrompt(piSystem({ customPrompt: custom }))).toBe(custom);
  });

  it("pins its markers to pi's own rendered prompt", () => {
    const sections = buildSystemPromptState({ cwd: "/repo" }).sections ?? {};

    // A reworded preamble or moved doc paths leave the gate matching nothing: update
    // PI_PREAMBLE or the trigger pair in prompt.ts.
    expect(sections.preamble).toContain(PI_PREAMBLE);
    expect(sections.docs).toContain("docs/custom-provider.md");
    expect(sections.docs).toContain("docs/packages.md");
  });
});

describe(toBridgeContext, () => {
  it("separates the conversation from the prompt and tools pi replays", () => {
    const tool = { name: "read", description: "Read a file", parameters: { type: "object" } };

    const context = toBridgeContext(
      transcript({
        systemPrompt: "Summarize.",
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
        tools: [tool],
      }),
    );

    expect(context.messages).toEqual([{ role: "user", content: "hi", timestamp: 0 }]);
    expect(context.tools?.map(({ name }) => name)).toEqual(["read"]);
    expect(systemText(context.system)).toBe("Summarize.");
  });
});
