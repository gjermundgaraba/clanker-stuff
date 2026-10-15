// The boundaries pi records prompts at, driven with pi-shaped events and contexts.

import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import type {
  BeforeAgentStartEvent,
  BuildSystemPromptOptions,
  ExtensionContext,
  Skill,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createExtensionHost,
  normalizedSystemPromptOptions,
} from "../../../../../tests/harness/extension-host.js";
import {
  PI_PREAMBLE,
  projectPromptCapture,
  PromptCaptures,
  sharedPromptCaptures,
} from "../../prompt/capture.js";
import { PromptRecorder } from "../../prompt/recorder.js";

const host = createExtensionHost(() => {});

function beforeAgentStart(
  systemPrompt: string,
  options: Omit<BuildSystemPromptOptions, "cwd"> = {},
): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    messageType: "user",
    prompt: "go",
    systemPrompt,
    systemPromptOptions: normalizedSystemPromptOptions({ cwd: "/w", ...options }),
  };
}

/** A context whose rendered prompt is `systemPrompt`, as at agent_start or turn_start. */
function rendering(systemPrompt: string): ExtensionContext {
  return host.createContext({ getSystemPrompt: () => systemPrompt });
}

function setup(): { captures: PromptCaptures; recorder: PromptRecorder } {
  const captures = new PromptCaptures();

  return { captures, recorder: new PromptRecorder(captures) };
}

// MCP tool descriptions merge into the prompt only after their servers connect, after
// before_agent_start, so the prompt the provider queries with is the widened one.
const PRE_WIDEN = "You are pi.\n# Tools\n- read: Read a file\n\npi packages (docs/packages.md)";

const WIDENED =
  "You are pi.\n# Tools\n- read: Read a file\n- Agent: Launch a subagent with a very long description ... \n\npi packages (docs/packages.md)";

const PROJECT_RULES = [{ path: "/AGENTS.md", content: "project rules" }];

describe("agent_start widened-prompt capture", () => {
  it("records the context's rendered prompt so the widened prompt itself resolves", () => {
    const { captures, recorder } = setup();

    recorder.beforeAgentStart(beforeAgentStart(PRE_WIDEN));

    expect(() => captures.resolveOrDerive(WIDENED)).toThrow(/no capture/);

    recorder.agentStart(rendering(WIDENED));

    expect(captures.resolve(WIDENED)?.source).toBe("agent_start");
  });

  it("lets a child embedding the widened parent resolve by inheritance", () => {
    const { captures, recorder } = setup();

    recorder.beforeAgentStart(beforeAgentStart(PRE_WIDEN));
    recorder.agentStart(rendering(WIDENED));

    // A subagent embeds the widened parent prompt verbatim as its prefix.
    const child = `${WIDENED}\n\n<sub_agent_context>be concise</sub_agent_context>\n\n<active_agent name="worker"/>`;
    const parent = captures.resolve(WIDENED);

    expect(captures.resolveOrDerive(child)?.inherited.map((edge) => edge.parent)).toEqual([parent]);
  });

  it("carries the stashed portable parts onto the widened key", () => {
    const { captures, recorder } = setup();

    recorder.beforeAgentStart(
      beforeAgentStart(PRE_WIDEN, {
        contextFiles: PROJECT_RULES,
        appendSystemPrompt: "be careful",
        sections: { mcp_servers: "- github" },
        selectedTools: ["read"],
      }),
    );
    recorder.agentStart(rendering(WIDENED));

    expect(captures.resolve(WIDENED)).toMatchObject({
      contextFiles: PROJECT_RULES,
      append: "be careful",
      sections: { mcp_servers: "- github" },
    });
  });

  it("forwards skills only when the run can read their files", () => {
    const skill: Skill = {
      name: "browser",
      description: "browser description",
      filePath: "/skills/browser/SKILL.md",
      baseDir: "/skills/browser",
      sourceInfo: createSyntheticSourceInfo("/skills/browser/SKILL.md", { source: "test" }),
      disableModelInvocation: false,
    };

    const { captures, recorder } = setup();

    recorder.beforeAgentStart(
      beforeAgentStart("reads", { skills: [skill], selectedTools: ["read", "bash"] }),
    );
    recorder.beforeAgentStart(
      beforeAgentStart("no read", { skills: [skill], selectedTools: ["bash"] }),
    );

    expect(captures.resolve("reads")?.skills).toEqual([skill]);
    expect(captures.resolve("no read")?.skills).toEqual([]);
  });

  it("records nothing for an empty rendered prompt", () => {
    const { captures, recorder } = setup();

    recorder.agentStart(rendering(""));

    expect(captures.size).toBe(0);
  });
});

describe("turn_start prompt capture", () => {
  it("re-keys a prompt rebuilt between turns with the stashed portable parts", () => {
    const { captures, recorder } = setup();

    recorder.beforeAgentStart(
      beforeAgentStart(PRE_WIDEN, { contextFiles: PROJECT_RULES, selectedTools: ["read"] }),
    );
    recorder.agentStart(rendering(WIDENED));

    // A later turn in the same run renders a new prompt (a mid-run tool-loadout change
    // or a section re-render).
    const turnTwo = `${WIDENED}\n# Tools\n- git_status: Report repo state\n`;

    recorder.turnStart(rendering(turnTwo));

    expect(captures.resolve(turnTwo)).toMatchObject({
      contextFiles: PROJECT_RULES,
      source: "turn_start",
    });
  });

  it("is idempotent when the same prompt is re-fired", () => {
    const { captures, recorder } = setup();

    recorder.beforeAgentStart(beforeAgentStart(PRE_WIDEN));
    recorder.agentStart(rendering(WIDENED));

    const before = captures.size;

    recorder.turnStart(rendering(WIDENED));
    recorder.turnStart(rendering(WIDENED));

    expect(captures.resolve(WIDENED)).toBeDefined();
    expect(captures.size).toBe(before);
  });
});

// Shapes the recorded boundaries do not close, pinned so the boundary stays explicit.
describe("prompt capture: documented gaps", () => {
  const section = (name: string, content: string): string => `<${name}>\n${content}\n</${name}>`;

  const parentSections = [
    `${PI_PREAMBLE}, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`,
    section(
      "tools",
      "- read: Read a file\n- bash: Run commands\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.",
    ),
    section(
      "rules",
      "- Use bash for file operations like ls, rg, find\n- Be concise in your responses",
    ),
    section(
      "docs",
      "Pi documentation (read only when the user asks about pi itself):\n- Main documentation: /pi/README.md",
    ),
    section(
      "project_context",
      'Project-specific instructions and guidelines:\n\n<project_instructions path="/parent/AGENTS.md">\nParent rules.\n</project_instructions>',
    ),
    section(
      "skills",
      "The following skills provide specialized instructions for specific tasks.\n\n<available_skills>\n  <skill>\n    <name>deploy</name>\n    <description>Deploy the application.</description>\n  </skill>\n</available_skills>",
    ),
    section("cwd", "/parent"),
  ];

  const PARENT_PROMPT = parentSections.join("\n\n");
  const STRIPPED_PARENT = parentSections.slice(0, 5).join("\n\n");

  const CHILD_WRAPPER =
    '<active_agent name="Explore"/>\n\n# Environment\nWorking directory: /child\nGit repository: yes\nBranch: main\nPlatform: darwin';

  const STRIPPED_CHILD = `${STRIPPED_PARENT}\n\n${CHILD_WRAPPER}`;

  it("resolves an isolated evaluation's captures through the shared registry (#64)", async () => {
    // A subagent host loads the extension fresh: a second evaluation of these modules.
    vi.resetModules();

    const fresh = await import("../../prompt/capture.js");
    const freshRecorder = await import("../../prompt/recorder.js");

    expect(fresh.PromptCaptures).not.toBe(PromptCaptures);

    const isolatedPrompt = "You are an isolated smoke-test agent. Respond with ZZ_ISO_OK.";
    const recorder = new freshRecorder.PromptRecorder(fresh.sharedPromptCaptures());

    recorder.beforeAgentStart(beforeAgentStart(isolatedPrompt));
    recorder.agentStart(rendering(isolatedPrompt));

    expect(fresh.sharedPromptCaptures()).toBe(sharedPromptCaptures());
    expect(sharedPromptCaptures().resolveOrDerive(isolatedPrompt)?.source).toBe("agent_start");
  });

  it("does not match a child embedding a tail-stripped parent prompt (#88)", () => {
    const { captures, recorder } = setup();

    recorder.beforeAgentStart(beforeAgentStart(PARENT_PROMPT));
    recorder.agentStart(rendering(PARENT_PROMPT));

    // A subagent that embeds its parent minus the per-session tail (skills, cwd).
    expect(() => captures.resolveOrDerive(STRIPPED_CHILD)).toThrow(/no capture/);
  });

  it("fails loudly when a recorded tail-stripped child has no inheritance edge (#88)", () => {
    const { captures, recorder } = setup();

    recorder.beforeAgentStart(beforeAgentStart(PARENT_PROMPT));
    recorder.agentStart(rendering(PARENT_PROMPT));
    // The child is recorded at both boundaries, but its custom prompt holds only the
    // tail-stripped parent, so no edge matches.
    recorder.beforeAgentStart(beforeAgentStart(STRIPPED_CHILD, { customPrompt: STRIPPED_CHILD }));
    recorder.agentStart(rendering(STRIPPED_CHILD));

    const child = captures.resolve(STRIPPED_CHILD);

    if (child === undefined) throw new Error("the tail-stripped child must be recorded");

    expect(child.inherited).toEqual([]);
    expect(() => projectPromptCapture(child, "none")).toThrow(
      /prompt-capture: refusing to send this prompt/,
    );
  });

  it("captures a handler-returned wholesale replacement at agent_start", () => {
    const { captures, recorder } = setup();
    const forced = "forced replacement prompt owning the request head";

    recorder.beforeAgentStart(beforeAgentStart("pi rendered prompt"));
    // pi renders a before_agent_start handler's returned prompt verbatim.
    recorder.agentStart(rendering(forced));

    // Only the portable parts are projected; the forced text's own prose is not forwarded.
    expect(captures.resolve(forced)?.source).toBe("agent_start");
  });

  it("does not rescue a prompt composed outside the before_agent_start pipeline (#102)", () => {
    const { captures, recorder } = setup();

    recorder.beforeAgentStart(beforeAgentStart("pi rendered prompt"));
    recorder.agentStart(rendering("pi rendered prompt"));

    expect(() => captures.resolveOrDerive("host-composed prompt owning the request head")).toThrow(
      /no capture/,
    );
  });

  it("does not see a prompt replaced between turn_start and the stream call (#91)", () => {
    const { captures, recorder } = setup();

    recorder.beforeAgentStart(beforeAgentStart("turn-1 prompt"));
    recorder.agentStart(rendering("turn-1 prompt"));
    recorder.turnStart(rendering("turn-2 rendered prompt"));

    expect(captures.resolveOrDerive("turn-2 rendered prompt")?.source).toBe("turn_start");
    // A context-event handler replacing the system message after turn_start is seen by
    // no recording boundary.
    expect(() =>
      captures.resolveOrDerive("replacement head installed by a context handler"),
    ).toThrow(/no capture/);
  });
});
