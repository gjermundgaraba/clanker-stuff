import { readFile } from "node:fs/promises";

import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import {
  getMarkdownTheme,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Box, fuzzyFilter, Markdown, Text } from "@earendil-works/pi-tui";

import { installSkillMentionEditor } from "./editor.js";

const SKILL_MENTION = /\$(?<name>[A-Za-z0-9_:-]+)/gu;
const SKILL_COMPLETION = /(?:^|[ \t])\$(?<query>[A-Za-z0-9_:-]*)$/u;
const SKILL_NAME = /^[A-Za-z0-9_:-]+$/u;
const DEFINITE_SHELL_PARAMETER = /^(?:\d+|[-_])$/u;
const SKILL_COMMAND_PREFIX = "skill:";
const COMMON_ENV_VARS = new Set([
  "HOME",
  "LANG",
  "PATH",
  "PWD",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CONFIG_HOME",
]);
const escapeSkillText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
const escapeSkillAttribute = (value: string): string =>
  escapeSkillText(value).replaceAll('"', "&quot;");

export interface InjectedSkillsDetails {
  skills: { body: string; name: string; path: string }[];
}

type Skill = NonNullable<BuildSystemPromptOptions["skills"]>[number];

const renderInjectedSkills: MessageRenderer<InjectedSkillsDetails> = (
  message,
  { expanded, outputPad },
  theme
) => {
  const skills = message.details?.skills ?? [];
  const header = theme.fg(
    "accent",
    `◆ Skills injected: ${skills.map((skill) => `$${skill.name}`).join(", ")}`
  );
  const bg = (content: string) => theme.bg("customMessageBg", content);

  if (!expanded) {
    return new Text(header, outputPad, 1, bg);
  }

  const box = new Box(outputPad, 1, bg);
  box.addChild(new Text(header, 0, 0));
  for (const skill of skills) {
    box.addChild(
      new Text(
        `${theme.fg("accent", `$${skill.name}`)}\n${theme.fg("dim", skill.path)}`,
        0,
        0
      )
    );
    box.addChild(new Markdown(skill.body, 0, 0, getMarkdownTheme()));
  }
  return box;
};

export const createSkillMentions = (pi: ExtensionAPI) => {
  let activeSkills: Skill[] = [];

  const getSkills = () =>
    pi
      .getCommands()
      .filter((command) => command.source === "skill")
      .map((command) => ({
        description: command.description,
        name: command.name.slice(SKILL_COMMAND_PREFIX.length),
      }))
      .filter(
        (skill) =>
          SKILL_NAME.test(skill.name) && !COMMON_ENV_VARS.has(skill.name)
      );

  const install = (ctx: ExtensionContext): void => {
    installSkillMentionEditor(ctx, () =>
      getSkills().map((skill) => skill.name)
    );

    ctx.ui.addAutocompleteProvider((current) => ({
      applyCompletion: current.applyCompletion.bind(current),
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const currentLine = lines[cursorLine] ?? "";
        const beforeCursor = currentLine.slice(0, cursorCol);
        const query = SKILL_COMPLETION.exec(beforeCursor)?.groups?.query;
        if (query === undefined) {
          return await current.getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            options
          );
        }
        if (DEFINITE_SHELL_PARAMETER.test(query)) {
          return null;
        }

        const items = fuzzyFilter(
          getSkills(),
          query,
          (skill) => skill.name
        ).map((skill) => ({
          ...(typeof skill.description === "string" &&
          skill.description.length > 0
            ? { description: skill.description }
            : {}),
          label: `$${skill.name}`,
          value: `$${skill.name}`,
        }));

        return items.length > 0 ? { items, prefix: `$${query}` } : null;
      },
      shouldTriggerFileCompletion:
        current.shouldTriggerFileCompletion?.bind(current),
      triggerCharacters: ["$"],
    }));
  };

  const loadMentionedSkills = async (
    text: string,
    skills: Skill[],
    ctx: ExtensionContext
  ) => {
    const mentionedNames = new Set<string>();
    for (const match of text.matchAll(SKILL_MENTION)) {
      const { name } = match.groups ?? {};
      if (name && !COMMON_ENV_VARS.has(name)) {
        mentionedNames.add(name);
      }
    }
    if (mentionedNames.size === 0) {
      return [];
    }

    const loadedBlocks = await Promise.all(
      skills
        .filter((skill) => mentionedNames.has(skill.name))
        .map(async (skill) => {
          try {
            const contents = await readFile(skill.filePath, "utf-8");
            const body = stripFrontmatter(contents).trim();
            return {
              body,
              content: `<skill name="${skill.name}" location="${escapeSkillAttribute(skill.filePath)}">\nReferences are relative to ${escapeSkillText(skill.baseDir)}.\n\n${body}\n</skill>`,
              name: skill.name,
              path: skill.filePath,
            };
          } catch (error) {
            ctx.ui.notify(
              `Failed to load skill ${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
              "warning"
            );
            return null;
          }
        })
    );
    return loadedBlocks.filter((block) => block !== null);
  };

  const inject = async (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext
  ): Promise<BeforeAgentStartEventResult | undefined> => {
    activeSkills = event.systemPromptOptions.skills ?? [];
    const blocks = await loadMentionedSkills(event.prompt, activeSkills, ctx);
    if (blocks.length === 0) {
      return undefined;
    }

    return {
      message: {
        content: blocks.map((block) => block.content).join("\n\n"),
        customType: "codex-skills",
        details: {
          skills: blocks.map(({ body, name, path }) => ({
            body,
            name,
            path,
          })),
        } satisfies InjectedSkillsDetails,
        display: true,
      },
    };
  };

  const injectStreaming = async (
    event: InputEvent,
    ctx: ExtensionContext
  ): Promise<InputEventResult | undefined> => {
    if (event.streamingBehavior === undefined) {
      return undefined;
    }
    const blocks = await loadMentionedSkills(event.text, activeSkills, ctx);
    return blocks.length === 0
      ? undefined
      : {
          action: "transform",
          images: event.images,
          text: `${blocks.map((block) => block.content).join("\n\n")}\n\n${event.text}`,
        };
  };

  return { inject, injectStreaming, install, render: renderInjectedSkills };
};
