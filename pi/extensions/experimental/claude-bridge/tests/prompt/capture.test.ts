import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

// pi does not export its prompt builder; these pins compare against the renderer pi runs.
import {
  buildSystemPrompt,
  buildSystemPromptSections,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import {
  collectPromptSkills,
  formatProjectContext,
  PI_PREAMBLE,
  projectPromptCapture,
  PromptCaptures,
  renderSkillsBlock,
} from "../../prompt/capture.js";
import type {
  PromptCapture,
  PromptCaptureDiagnostic,
  PromptCaptureInput,
  SkillReadTool,
} from "../../prompt/capture.js";

const PI_HARNESS =
  "You are an expert coding assistant operating inside pi. Pi documentation: pi packages (docs/packages.md).";

const PARENT_KEY = `${PI_HARNESS}\n\n<project_context>raw parent context</project_context>\nCurrent working directory: /parent`;

const CHILD_SUFFIX =
  '\n\n<sub_agent_context>child rules</sub_agent_context>\n\n<active_agent name="Plan"/>\n\n# Environment\nWorking directory: /child\n\n<agent_instructions>plan carefully</agent_instructions>';

const CHILD_KEY = `${PARENT_KEY}${CHILD_SUFFIX}\nCurrent working directory: /child`;

function skill(name: string, disabled = false): Skill {
  return {
    name,
    description: `${name} description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "test" }),
    disableModelInvocation: disabled,
  };
}

function capture(overrides: Partial<PromptCaptureInput> = {}): PromptCaptureInput {
  return { contextFiles: [], skills: [], ...overrides };
}

function resolved(captures: PromptCaptures, key: string): PromptCapture {
  const found = captures.resolve(key);

  if (found === undefined) throw new Error(`missing capture for ${key.slice(0, 30)}`);

  return found;
}

function projected(captures: PromptCaptures, key: string, readTool: SkillReadTool = "mcp"): string {
  const text = projectPromptCapture(resolved(captures, key), readTool);

  if (text === undefined) throw new Error(`nothing projected for ${key.slice(0, 30)}`);

  return text;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe(PromptCaptures, () => {
  it("keeps parent and child captures isolated", () => {
    const captures = new PromptCaptures();

    captures.record(
      PARENT_KEY,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }),
    );
    captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));

    expect(resolved(captures, PARENT_KEY).contextFiles).toHaveLength(1);
    expect(resolved(captures, CHILD_KEY).contextFiles).toHaveLength(0);
    expect(captures.resolve("unknown")).toBeUndefined();
    expect(captures.resolve(undefined)).toBeUndefined();
  });

  it("derives a transient capture when a later extension wrapped the prompt", () => {
    const captures = new PromptCaptures();

    captures.record(
      PARENT_KEY,
      capture({
        contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
        skills: [skill("browser")],
      }),
    );

    // What an extension loading after the bridge produces: our recorded prompt,
    // wrapped in text we never saw.
    const wrapped = `PREFIX FROM ANOTHER EXTENSION\n\n${PARENT_KEY}\n\nSUFFIX`;
    const derived = captures.resolveOrDerive(wrapped);

    if (derived === undefined) throw new Error("the wrapped prompt must derive a capture");

    const result = projectPromptCapture(derived, "mcp");

    expect(result).toMatch(/parent rules/);
    expect(result).toMatch(/browser/);
    // The wrapper's own text is instruction too: accept the prompt whole or refuse it,
    // never accept it and discard what surrounds the embedded capture.
    expect(result).toMatch(/PREFIX FROM ANOTHER EXTENSION/);
    expect(result).toMatch(/SUFFIX/);
    expect(result).not.toMatch(/Pi documentation/);
    expect(captures.resolve(wrapped)).toBeUndefined();
  });

  it("revives an exact capture whose lookup key was evicted", () => {
    const captures = new PromptCaptures(undefined, 2);

    captures.record(
      PARENT_KEY,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }),
    );
    // The child keeps the parent node alive by reference once its key is gone.
    captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
    captures.record("unrelated", capture());

    expect(captures.resolve(PARENT_KEY)).toBeUndefined();

    const revived = captures.resolveOrDerive(PARENT_KEY);

    expect(revived?.contextFiles).toEqual([{ path: "/AGENTS.md", content: "parent rules" }]);
    // Revival re-adds a key, so it has to trim like a write.
    expect(captures.size).toBe(2);
  });

  it("keeps a parent alive that is only ever resolved, never re-recorded", () => {
    // One long-lived parent agent, then a stream of sub-agents each recording a prompt
    // of its own. Counting only writes would age the parent out.
    const captures = new PromptCaptures(undefined, 4);

    captures.record(
      PARENT_KEY,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }),
    );

    for (let index = 0; index < 8; index++) {
      expect(
        captures.resolve(PARENT_KEY),
        `parent evicted after ${index} sub-agents`,
      ).toBeDefined();
      captures.record(`sub-agent prompt ${index}`, capture());
    }

    expect(resolved(captures, PARENT_KEY).contextFiles).toHaveLength(1);
  });

  it("throws rather than silently dropping instructions it cannot account for", () => {
    const captures = new PromptCaptures();

    captures.record(
      PARENT_KEY,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }),
    );

    expect(() =>
      captures.resolveOrDerive("a prompt sharing nothing with what we recorded"),
    ).toThrow(/no capture for this .* system prompt/);
    // No prompt at all is not a loss: there is nothing to forward.
    expect(captures.resolveOrDerive(undefined)).toBeUndefined();
  });

  it("reports the closest known capture when a prompt matches nothing", () => {
    const diagnostics: PromptCaptureDiagnostic[] = [];
    const captures = new PromptCaptures((diagnostic) => diagnostics.push(diagnostic), 64);

    captures.record("prefix-common-THE-REST", capture());

    expect(() => captures.resolveOrDerive("prefix-common-WHO-ARE-YOU")).toThrow(
      /diverges at offset 14 \(22-char key\)/,
    );
    expect(diagnostics).toEqual([
      {
        systemPrompt: "prefix-common-WHO-ARE-YOU",
        matches: [{ key: "prefix-common-THE-REST", firstDivergent: 14, source: undefined }],
      },
    ]);
  });

  it("names the truncated capture when a prompt is a recorded key with its tail missing", () => {
    const captures = new PromptCaptures();
    const tail = "\n\n<skills>extension additions</skills>";

    // The issue #144 shape: the next turn's prompt is the last recorded key without the
    // extension's additions, because an idle triggerTurn skipped before_agent_start.
    captures.record(`${PARENT_KEY}${tail}`, capture(), "turn_start");

    expect(() => captures.resolveOrDerive(PARENT_KEY)).toThrow(
      `recorded at turn_start with its final ${tail.length} chars missing`,
    );
  });

  it("recursively projects an inherited prompt without Pi's harness", () => {
    const browser = skill("browser");
    const captures = new PromptCaptures();

    captures.record(
      PARENT_KEY,
      capture({
        contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
        skills: [browser],
      }),
    );
    captures.record(
      CHILD_KEY,
      capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [browser] }),
    );

    const parent = projected(captures, PARENT_KEY);
    const child = projected(captures, CHILD_KEY);

    // The child retains the parent's projected cache prefix.
    expect(child.startsWith(parent)).toBe(true);
    expect(child).not.toMatch(/operating inside pi|pi packages/);
    expect(child).toMatch(/parent rules/);
    expect(child).toContain("<sub_agent_context>child rules</sub_agent_context>");
    expect(child).toContain('<active_agent name="Plan"/>');
    expect(child).toContain("<agent_instructions>plan carefully</agent_instructions>");
    expect(occurrences(child, "/skills/browser/SKILL.md")).toBe(1);
  });

  it("leaves direct custom and replace-mode prompts byte-identical", () => {
    const captures = new PromptCaptures();

    captures.record("direct assembled", capture({ custom: "  direct user instructions\n" }));
    captures.record(
      "replace assembled",
      capture({ custom: '<active_agent name="review"/>\nreplace instructions' }),
    );

    expect(projected(captures, "direct assembled")).toBe("  direct user instructions\n");
    expect(projected(captures, "replace assembled")).toBe(
      '<active_agent name="review"/>\nreplace instructions',
    );
  });

  it("uses the longest inherited key for nested agents", () => {
    const captures = new PromptCaptures();
    const grandSuffix = "\n\n<sub_agent_context>grandchild rules</sub_agent_context>";
    const grandKey = `${CHILD_KEY}${grandSuffix}\nCurrent working directory: /grandchild`;

    captures.record(
      PARENT_KEY,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }),
    );
    captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
    captures.record(grandKey, capture({ custom: `${CHILD_KEY}${grandSuffix}` }));

    const grandchild = projected(captures, grandKey);

    expect(grandchild).not.toMatch(
      /operating inside pi|Current working directory: \/parent|Current working directory: \/child/,
    );
    expect(occurrences(grandchild, "parent rules")).toBe(1);
    expect(grandchild).toMatch(/child rules/);
    expect(grandchild).toMatch(/grandchild rules/);
  });

  it("retains inherited nodes after their lookup keys are evicted", () => {
    const captures = new PromptCaptures(undefined, 2);

    captures.record(
      PARENT_KEY,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "survives eviction" }] }),
    );
    captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
    captures.record("unrelated", capture());

    expect(captures.resolve(PARENT_KEY)).toBeUndefined();
    expect(projected(captures, CHILD_KEY)).toMatch(/survives eviction/);
  });

  it("relinks an evicted ancestor through the live inheritance graph", () => {
    const captures = new PromptCaptures(undefined, 2);
    const changedKey = "changed child assembled prompt";

    captures.record(
      PARENT_KEY,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "reachable ancestor" }] }),
    );
    captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
    captures.record("unrelated", capture());
    captures.record(changedKey, capture({ custom: `${PARENT_KEY}\n\nchanged child rules` }));

    const changed = projected(captures, changedKey);

    expect(changed).not.toMatch(/operating inside pi/);
    expect(changed).toMatch(/reachable ancestor/);
    expect(changed).toMatch(/changed child rules/);
  });

  it("updates descendants through a re-recorded parent node", () => {
    const captures = new PromptCaptures();

    captures.record(
      PARENT_KEY,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "rules v1" }] }),
    );
    captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
    captures.record(
      PARENT_KEY,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "rules v2" }] }),
    );
    captures.record(
      CHILD_KEY,
      capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, append: "child append" }),
    );

    const child = projected(captures, CHILD_KEY);

    expect(child).not.toMatch(/rules v1|operating inside pi/);
    expect(child).toMatch(/rules v2/);
    expect(child).toMatch(/child append$/);
  });

  it("projects every non-overlapping occurrence of an inherited prompt", () => {
    const captures = new PromptCaptures();

    captures.record(
      PARENT_KEY,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "repeated rules" }] }),
    );
    captures.record(
      "repeated child",
      capture({ custom: `${PARENT_KEY}\nseparator\n${PARENT_KEY}` }),
    );

    const result = projected(captures, "repeated child");

    expect(result).not.toMatch(/operating inside pi/);
    expect(occurrences(result, "repeated rules")).toBe(2);
  });

  it("deduplicates inherited skills and preserves child-only skills", () => {
    const browser = skill("browser");
    const review = skill("review");
    const captures = new PromptCaptures();

    captures.record(PARENT_KEY, capture({ skills: [browser] }));
    captures.record(
      CHILD_KEY,
      capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [browser, review] }),
    );

    const child = resolved(captures, CHILD_KEY);

    expect(collectPromptSkills(child).map(({ name }) => name)).toEqual(["browser", "review"]);

    const result = projectPromptCapture(child, "mcp") ?? "";

    expect(occurrences(result, "/skills/browser/SKILL.md")).toBe(1);
    expect(occurrences(result, "/skills/review/SKILL.md")).toBe(1);
  });

  it("allows an enabled child skill when the inherited copy is hidden", () => {
    const captures = new PromptCaptures();

    captures.record(PARENT_KEY, capture({ skills: [skill("browser", true)] }));
    captures.record(
      CHILD_KEY,
      capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [skill("browser")] }),
    );

    expect(occurrences(projected(captures, CHILD_KEY), "/skills/browser/SKILL.md")).toBe(1);
  });

  it("is bounded and evicts the least-recently-recorded key", () => {
    const captures = new PromptCaptures(undefined, 3);

    captures.record("a", capture());
    captures.record("b", capture());
    captures.record("c", capture());
    captures.record("a", capture({ custom: "refreshed" }));
    captures.record("d", capture());

    expect(captures.size).toBe(3);
    expect(captures.resolve("b")).toBeUndefined();
    expect(resolved(captures, "a").custom).toBe("refreshed");
    expect(captures.resolve("c")).toBeDefined();
    expect(captures.resolve("d")).toBeDefined();
  });
});

describe("prompt sections", () => {
  const MCP_CONTENT = "- mcp__github (codemode): GitHub tools";
  const MCP_SECTION = `<mcp_servers>\n${MCP_CONTENT}\n</mcp_servers>`;

  it("projects a recorded section after the appended instructions, in pi's wrapper format", () => {
    const captures = new PromptCaptures();

    captures.record(
      "sectioned prompt",
      capture({ append: "be careful", sections: { mcp_servers: MCP_CONTENT } }),
    );

    expect(projected(captures, "sectioned prompt")).toBe(`be careful\n\n${MCP_SECTION}`);
    // The projection must be byte-identical to the text pi's builder put into the prompt
    // this capture keys.
    expect(
      buildSystemPromptSections({ cwd: "/w", sections: { mcp_servers: MCP_CONTENT } })[
        "mcp_servers"
      ],
    ).toBe(MCP_SECTION);
  });

  it("skips an empty section, as pi's builder does", () => {
    const captures = new PromptCaptures();

    captures.record("one empty section", capture({ sections: { mcp_servers: "", other: "kept" } }));

    expect(projected(captures, "one empty section")).toBe("<other>\nkept\n</other>");
  });

  it("keeps the recorded sections when the caller mutates its own map", () => {
    // systemPromptOptions is a live object: later before_agent_start handlers edit it.
    const sections = { mcp_servers: MCP_CONTENT };
    const captures = new PromptCaptures();

    captures.record("live options", capture({ sections }));
    sections.mcp_servers = "mutated";

    expect(projected(captures, "live options")).toBe(MCP_SECTION);
  });

  it("drops a section a later recording no longer carries", () => {
    const captures = new PromptCaptures();

    captures.record("sectioned prompt", capture({ sections: { mcp_servers: MCP_CONTENT } }));

    expect(projected(captures, "sectioned prompt")).toBe(MCP_SECTION);

    captures.record("sectioned prompt", capture({ sections: {} }));

    expect(projectPromptCapture(resolved(captures, "sectioned prompt"), "mcp")).toBeUndefined();
  });

  it("projects an inherited prompt's section through a child, once", () => {
    const captures = new PromptCaptures();

    captures.record(
      PARENT_KEY,
      capture({
        contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
        sections: { mcp_servers: MCP_CONTENT },
      }),
    );
    captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));

    const child = projected(captures, CHILD_KEY);

    expect(occurrences(child, MCP_SECTION)).toBe(1);
    expect(child).not.toMatch(/operating inside pi/);
  });

  it.each([
    ["leaked_harness", `${PI_PREAMBLE}, a coding agent harness.`],
    ["triggers", "see docs/custom-provider.md and docs/packages.md"],
  ])("refuses a %s section on its own", (name, content) => {
    const captures = new PromptCaptures();

    captures.record(
      "guarded prompt",
      capture({ sections: { [name]: content } }),
      "before_agent_start",
    );

    expect(() => projectPromptCapture(resolved(captures, "guarded prompt"), "none")).toThrow(
      `in the ${name} section`,
    );
  });
});

describe("capture provenance", () => {
  it("records which boundary last wrote a key", () => {
    const captures = new PromptCaptures();

    captures.record("key", capture(), "agent_start");

    expect(resolved(captures, "key").source).toBe("agent_start");

    captures.record("key", capture(), "turn_start");

    expect(resolved(captures, "key").source).toBe("turn_start");
  });

  it("names the closest match's boundary in a throw", () => {
    const captures = new PromptCaptures();

    captures.record("prefix-common-THE-REST", capture(), "agent_start");

    expect(() => captures.resolveOrDerive("prefix-common-WHO-ARE-YOU")).toThrow(
      /recorded at agent_start/,
    );
  });
});

describe("prompt guard", () => {
  it("throws when a recorded custom prompt carries pi's preamble at a line start", () => {
    const captures = new PromptCaptures();

    captures.record(
      "leaking prompt",
      capture({
        custom: `${PI_PREAMBLE}, a coding agent harness.\n\n<tools>\n- read: Read a file\n</tools>`,
      }),
      "before_agent_start",
    );

    const found = resolved(captures, "leaking prompt");

    expect(() => projectPromptCapture(found, "none")).toThrow(PI_PREAMBLE);
    expect(() => projectPromptCapture(found, "none")).toThrow(/offset 0 of \d+ chars/);
    expect(() => projectPromptCapture(found, "none")).toThrow(/Capture: before_agent_start/);
  });

  it("checks the custom text after replacing a matched inherited prompt", () => {
    const captures = new PromptCaptures();
    const parentPrompt = `${PI_PREAMBLE}, a coding agent harness.\n\n<tools>\n- read: Read a file\n</tools>`;

    captures.record(
      parentPrompt,
      capture({ contextFiles: [{ path: "/parent/AGENTS.md", content: "parent rules" }] }),
      "agent_start",
    );
    captures.record(
      "child assembled prompt",
      capture({ custom: `child wrapper\n\n${parentPrompt}\n\nchild instructions` }),
      "agent_start",
    );

    const child = resolved(captures, "child assembled prompt");

    expect(child.inherited).toHaveLength(1);

    const result = projectPromptCapture(child, "none");

    expect(result).not.toContain(PI_PREAMBLE);
    expect(result).toMatch(/child wrapper/);
    expect(result).toMatch(/parent rules/);
  });

  // Either file alone passes, so the pair split across two files still trips the gate.
  it("throws when context files carry the trigger pair, naming the files", () => {
    const captures = new PromptCaptures();

    captures.record(
      "context-only prompt",
      capture({
        contextFiles: [
          { path: "/AGENTS.md", content: "see docs/custom-provider.md" },
          { path: "/unrelated/AGENTS.md", content: "nothing to see" },
          { path: "/repo/AGENTS.md", content: "and docs/packages.md" },
        ],
      }),
      "before_agent_start",
    );

    expect(() => projectPromptCapture(resolved(captures, "context-only prompt"), "none")).toThrow(
      "docs/custom-provider.md and docs/packages.md in the project context block (from /AGENTS.md, /repo/AGENTS.md)",
    );
  });

  it.each(["docs/custom-provider.md", "docs/packages.md"])("ignores %s on its own", (path) => {
    const captures = new PromptCaptures();
    const custom = `see ${path}`;

    captures.record("one path", capture({ custom }), "before_agent_start");

    expect(projected(captures, "one path", "none")).toBe(custom);
  });

  it("ignores a mid-line mention of pi's preamble", () => {
    const captures = new PromptCaptures();
    const custom = `note: ${PI_PREAMBLE}, allegedly`;

    captures.record("mid-line prompt", capture({ custom }), "before_agent_start");

    expect(projected(captures, "mid-line prompt", "none")).toBe(custom);
  });

  it("pins the guard's marker in pi's own rendered system prompt", () => {
    const harness = buildSystemPrompt({ cwd: "/tmp" });

    // A reworded preamble or moved doc paths leave the guard matching nothing: update
    // PI_PREAMBLE or ANTHROPIC_THIRD_PARTY_TRIGGERS in prompt/capture.ts.
    expect(harness).toContain(PI_PREAMBLE);
    expect(harness).toContain("docs/custom-provider.md");
    expect(harness).toContain("docs/packages.md");

    // A custom prompt replaces the harness in full, which is what makes these strings'
    // presence mean "this prompt carries pi's harness or its gate fingerprint".
    const custom = buildSystemPrompt({ cwd: "/tmp", customPrompt: "custom" });

    expect(custom).not.toContain(PI_PREAMBLE);
    expect(custom).not.toContain("docs/packages.md");
  });
});

describe(renderSkillsBlock, () => {
  it("formats skills and names the MCP read tool for provider queries", () => {
    const result = renderSkillsBlock([skill("browser")], "mcp");

    expect(result?.startsWith("The following skills")).toBe(true);
    expect(result).toContain("Use the read tool (mcp__custom-tools__read) to load a skill's file");
    expect(result).toContain("<location>/skills/browser/SKILL.md</location>");
  });

  it("emits nothing without a usable reader or visible skills", () => {
    expect(renderSkillsBlock([skill("browser")], "none")).toBeUndefined();
    expect(renderSkillsBlock([], "mcp")).toBeUndefined();
    expect(renderSkillsBlock([skill("hidden", true)], "mcp")).toBeUndefined();
  });

  it("uses Pi's XML escaping", () => {
    const escaped = { ...skill("browser"), description: "read <this> & that" };

    expect(renderSkillsBlock([escaped], "mcp")).toContain("read &lt;this&gt; &amp; that");
  });
});

describe(formatProjectContext, () => {
  it("preserves Pi's file order and labels each with its path", () => {
    const prompt = formatProjectContext([
      { path: "/agent/AGENTS.md", content: "global instructions" },
      { path: "/project/CLAUDE.md", content: "parent instructions" },
      { path: "/project/nested/AGENTS.md", content: "nested instructions" },
    ]);

    if (prompt === undefined) throw new Error("context files must render a block");

    expect(prompt).toMatch(/^<project_context>\n\nProject-specific instructions and guidelines:/);
    expect(prompt.indexOf("global instructions")).toBeLessThan(
      prompt.indexOf("parent instructions"),
    );
    expect(prompt.indexOf("parent instructions")).toBeLessThan(
      prompt.indexOf("nested instructions"),
    );
    expect(prompt).toContain('<project_instructions path="/project/CLAUDE.md">');
  });

  it("returns undefined when Pi finds no context files", () => {
    expect(formatProjectContext([])).toBeUndefined();
  });
});
