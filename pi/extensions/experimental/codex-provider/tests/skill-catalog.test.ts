import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import type {
  BeforeAgentStartEvent,
  BuildSystemPromptOptions,
  ExtensionContext,
  Skill,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
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
  const systemPromptOptions = {
    cwd: "/tmp/project",
    selectedTools,
    skills,
  } satisfies BuildSystemPromptOptions;
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
  it.each(["exec_command", "exec", "bash"])(
    "restores loaded skill metadata with the active %s loader",
    (loader) => {
      const event = createEvent([loader]);

      expect(exposeSkillsWithoutRead(event, createContext())?.systemPrompt).toContain(
        `Use the \`${loader}\` tool to load a skill's file when the task matches its description.`,
      );
      expect(exposeSkillsWithoutRead(event, createContext())?.systemPrompt).toContain(
        "<available_skills>\n  <skill>\n    <name>example</name>\n    <description>Example &amp; verification</description>\n    <location>/tmp/example/SKILL.md</location>",
      );
    },
  );

  it("defers to Pi's catalog when read is active", () => {
    const event = createEvent(["read"]);

    expect(exposeSkillsWithoutRead(event, createContext())).toBeUndefined();
  });

  it("does not expose a catalog outside the applicable Codex tool path", () => {
    const disabled = { ...SKILL, disableModelInvocation: true };

    expect(
      exposeSkillsWithoutRead(createEvent(["exec_command"]), createContext("anthropic")),
    ).toBeUndefined();
    expect(exposeSkillsWithoutRead(createEvent(["apply_patch"]), createContext())).toBeUndefined();
    expect(
      exposeSkillsWithoutRead(createEvent(["exec_command"], [disabled]), createContext()),
    ).toBeUndefined();
  });
});
