import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import type {
  BeforeAgentStartEvent,
  ExtensionContext,
  Skill,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import {
  createExtensionHost,
  normalizedSystemPromptOptions,
} from "../../../../tests/harness/extension-host.js";
import { exposeSkillsWithoutRead } from "../skill-catalog.js";
import { createToolsModel } from "./fixtures.js";

const SOURCE_INFO = createSyntheticSourceInfo("<test>", {
  origin: "top-level",
  scope: "project",
  source: "test",
});

const SKILL = {
  baseDir: "/tmp/example",
  description: "Example & verification",
  disableModelInvocation: false,
  filePath: "/tmp/example/SKILL.md",
  name: "example",
  sourceInfo: SOURCE_INFO,
} satisfies Skill;

const createEvent = (selectedTools: string[], skills: Skill[] = [SKILL]): BeforeAgentStartEvent => {
  const systemPromptOptions = normalizedSystemPromptOptions({
    cwd: "/tmp/project",
    selectedTools,
    skills,
  });

  return {
    prompt: "Do the work",
    systemPrompt: "Base system prompt",
    systemPromptOptions,
    type: "before_agent_start",
  };
};

const host = createExtensionHost(() => {});

const createContext = (provider = "openai-codex"): ExtensionContext =>
  host.createContext({ model: { ...createToolsModel("gpt-5.6-sol"), provider } });

describe("Codex skill catalog", () => {
  it.each(["exec_command", "exec"])(
    "restores loaded skill metadata with active %s despite stale prompt options",
    (loader) => {
      const event = createEvent([loader === "exec" ? "exec_command" : "exec"]);

      exposeSkillsWithoutRead(event, createContext(), [loader]);

      const catalog = event.systemPromptOptions.sections.skills;
      expect(catalog).toContain(
        `Use the \`${loader}\` tool to load a skill's file when the task matches its description.`,
      );
      expect(catalog).toContain(
        "<available_skills>\n  <skill>\n    <name>example</name>\n    <description>Example &amp; verification</description>\n    <location>/tmp/example/SKILL.md</location>",
      );
      expect(catalog).not.toMatch(/^\s|\s$/u);
    },
  );

  it("defers to Pi's catalog when read is active", () => {
    const event = createEvent(["read"]);

    exposeSkillsWithoutRead(event, createContext(), ["read"]);

    expect(event.systemPromptOptions.sections).not.toHaveProperty("skills");
  });

  it("does not expose a catalog outside the applicable Codex tool path", () => {
    const disabled = { ...SKILL, disableModelInvocation: true };

    const cases = [
      {
        context: createContext("anthropic"),
        event: createEvent(["exec_command"]),
        tools: ["exec_command"],
      },
      { context: createContext(), event: createEvent(["bash"]), tools: ["bash"] },
      { context: createContext(), event: createEvent(["apply_patch"]), tools: ["apply_patch"] },
      {
        context: createContext(),
        event: createEvent(["exec_command"], [disabled]),
        tools: ["exec_command"],
      },
    ];

    for (const { context, event, tools } of cases) {
      exposeSkillsWithoutRead(event, context, tools);
      expect(event.systemPromptOptions.sections).not.toHaveProperty("skills");
    }
  });
});
